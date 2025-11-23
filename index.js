require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const axios = require('axios'); // npm install axios

// === GERENCIAMENTO VIA PM2 ===
// A limpeza de cache e reinicialização agora são feitas pelo PM2
// através do script restart-bots.js

// === SISTEMA DE NOTIFICAÇÕES DE REINICIALIZAÇÃO ===
const ARQUIVO_SINAL_RESTART = path.join(__dirname, '.restart_signal.json');

// Função para enviar notificação em todos os grupos
async function notificarGrupos(mensagem) {
    try {
        const chats = await client.getChats();
        const grupos = chats.filter(chat => chat.isGroup);

        console.log(`📢 Enviando notificação para ${grupos.length} grupos...`);

        for (const grupo of grupos) {
            try {
                await grupo.sendMessage(mensagem);
                console.log(`✅ Notificação enviada para: ${grupo.name}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Delay entre mensagens
            } catch (error) {
                console.error(`❌ Erro ao notificar grupo ${grupo.name}:`, error.message);
            }
        }
    } catch (error) {
        console.error('❌ Erro ao notificar grupos:', error.message);
    }
}

// Verificar se há sinal para notificar antes de desligar
async function verificarSinalRestart() {
    try {
        if (fssync.existsSync(ARQUIVO_SINAL_RESTART)) {
            const sinal = JSON.parse(await fs.readFile(ARQUIVO_SINAL_RESTART, 'utf-8'));

            if (sinal.tipo === 'pre-restart') {
                console.log('🔔 Sinal de pré-reinicialização detectado!');

                const horaAtual = new Date().toLocaleTimeString('pt-BR');
                await notificarGrupos(`⚠️ *AVISO DE MANUTENÇÃO*\n\n🔧 O bot será reiniciado para manutenção preventiva\n⏱️ Horário: ${horaAtual}\n🎯 Objetivo: Manter o sistema rápido e saudável\n⏳ Tempo estimado: 1-2 minutos\n\n_Aguarde alguns instantes..._`);

                // Aguardar 3 segundos para garantir que as mensagens foram enviadas
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Marcar como notificado e aguardando restart
                await fs.writeFile(ARQUIVO_SINAL_RESTART, JSON.stringify({
                    tipo: 'aguardando-restart',
                    horaNotificacao: new Date().toISOString()
                }));

                console.log('✅ Grupos notificados, aguardando PM2 reiniciar...');
            }
        }
    } catch (error) {
        console.error('❌ Erro ao verificar sinal de restart:', error.message);
    }
}

// Verificar se acabou de reiniciar e notificar
async function verificarPosRestart() {
    try {
        if (fssync.existsSync(ARQUIVO_SINAL_RESTART)) {
            const sinal = JSON.parse(await fs.readFile(ARQUIVO_SINAL_RESTART, 'utf-8'));

            if (sinal.tipo === 'aguardando-restart') {
                console.log('✅ Bot reiniciado! Notificando grupos...');

                // Aguardar 5 segundos para garantir que o WhatsApp está conectado
                await new Promise(resolve => setTimeout(resolve, 5000));

                const horaAtual = new Date().toLocaleTimeString('pt-BR');
                await notificarGrupos(`✅ *BOT ONLINE*\n\n🎉 Manutenção concluída com sucesso!\n⏰ Horário: ${horaAtual}\n💚 Sistema otimizado e funcionando normalmente\n\n_Todos os serviços estão operacionais!_`);

                // Remover arquivo de sinal
                await fs.unlink(ARQUIVO_SINAL_RESTART);
                console.log('✅ Grupos notificados sobre reconexão!');
            }
        }
    } catch (error) {
        console.error('❌ Erro ao verificar pós-restart:', error.message);
    }
}

// Verificar sinais periodicamente (a cada 10 segundos)
setInterval(verificarSinalRestart, 10000);

// === AXIOS SIMPLIFICADO (SEGUINDO PADRÃO BOT1) ===
const axiosInstance = axios.create({
    timeout: 60000, // 60 segundos - tolerância a conexões lentas
    maxRedirects: 3,
    headers: {
        'User-Agent': 'WhatsApp-Bot/1.0'
    }
});

// === FUNÇÃO DE RETRY COM BACKOFF EXPONENCIAL ===
async function axiosComRetry(config, maxTentativas = 3) {
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            const response = await axiosInstance(config);
            return response;
        } catch (error) {
            const ehTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
            const ehUltimaTentativa = tentativa === maxTentativas;

            if (ehTimeout && !ehUltimaTentativa) {
                // Aumentado delay progressivo: 3s, 5s, 7s (para dar tempo do cache do API MariaDB)
                const delayMs = Math.min(3000 + (2000 * (tentativa - 1)), 10000); // 3s, 5s, 7s
                console.log(`⏳ Timeout na tentativa ${tentativa}/${maxTentativas}, aguardando ${delayMs}ms antes de tentar novamente...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            throw error; // Se não é timeout ou é última tentativa, lança o erro
        }
    }
}

// === SISTEMA DE LOGS OTIMIZADO (MODO SILENCIOSO) ===
const SILENT_MODE = true; // Reduzir logs desnecessários para performance
const LOG_LEVEL = {
    ERROR: 0,   // Sempre mostrar erros
    WARN: 1,    // Mostrar avisos importantes
    INFO: 2,    // Mostrar informações essenciais
    DEBUG: 3    // Mostrar debug (desabilitado em modo silencioso)
};

function smartLog(level, message, ...args) {
    if (SILENT_MODE && level === LOG_LEVEL.DEBUG) return; // Pular logs debug
    if (level <= LOG_LEVEL.WARN || !SILENT_MODE) {
        console.log(message, ...args);
    }
}

// === CACHE ADMIN SIMPLIFICADO (SEGUINDO PADRÃO BOT1) ===
const adminCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getAdminFromCache(userId) {
    const entry = adminCache.get(userId);
    if (!entry || Date.now() - entry.timestamp > ADMIN_CACHE_TTL) {
        adminCache.delete(userId);
        return null;
    }
    return entry.isAdmin;
}

function setAdminCache(userId, isAdmin) {
    adminCache.set(userId, {
        isAdmin,
        timestamp: Date.now()
    });
}

// === IMPORTAR A IA ===
const WhatsAppAI = require('./whatsapp_ai');

// === IMPORTAR SISTEMA DE PACOTES ===
const SistemaPacotes = require('./sistema_pacotes');

// === IMPORTAR SISTEMA DE COMPRAS ===
const SistemaCompras = require('./sistema_compras');

// === IMPORTAR SISTEMA DE RELATÓRIOS ===
const SistemaRelatorios = require('./sistema_relatorios');

// === IMPORTAR SISTEMA DE BÔNUS ===
const SistemaBonus = require('./sistema_bonus');

// === IMPORTAR SISTEMA DE CONFIGURAÇÃO DE GRUPOS ===
const SistemaConfigGrupos = require('./sistema_config_grupos');

// === CONFIGURAÇÃO API MARIADB - BOT RETALHO ===
const API_PEDIDOS_CONFIG = {
    scriptUrl: process.env.API_PEDIDOS_URL || 'http://localhost:3002/api/pedidos',
    baseUrl: 'http://localhost:3002',
    timeout: 5000,
    retryAttempts: 3,
    retryDelay: 500
};

// === CONFIGURAÇÃO API MARIADB - PACOTES ESPECIAIS ===
const API_DIAMANTE_CONFIG = {
    scriptUrl: process.env.API_DIAMANTE_URL || 'http://localhost:3002/api/diamante',
    timeout: 5000,
    retryAttempts: 3,
    retryDelay: 500
};

// === MAPEAMENTO DE CÓDIGOS DE PACOTES ESPECIAIS ===
const CODIGOS_PACOTES_ESPECIAIS = {
    1: {
        nome: 'Pacote Diamante',
        descricao: 'Chamadas + SMS ilimitados + GB',
        gbBase: 11, // GB base do pacote diamante
        identificador: 'diamante',
        emoji: '💎'
    },
    2: {
        nome: 'Pacote 2.8GB',
        descricao: 'Pacote fixo de 2.8GB',
        gbFixo: 2.8, // GB fixo (não divide)
        identificador: 'pacote_2_8gb',
        emoji: '📦'
    }
    // Adicionar mais códigos conforme necessário:
    // 3: { nome: 'Pacote X', ... },
    // 4: { nome: 'Pacote Y', ... },
};

// === CONFIGURAÇÃO API MARIADB - PAGAMENTOS ===
const API_PAGAMENTOS_CONFIG = {
    scriptUrl: process.env.API_PAGAMENTOS_URL || 'http://localhost:3002/api/pagamentos',
    timeout: 5000
};

console.log(`📊 API MariaDB configurada (Pedidos + Diamante + Pagamentos)`);

// Função helper para reply com fallback
async function safeReply(message, client, texto) {
    try {
        await message.reply(texto);
    } catch (error) {
        console.log('⚠️ Erro no reply, usando sendMessage como fallback:', error.message);
        try {
            await client.sendMessage(message.from, texto);
        } catch (fallbackError) {
            console.error('❌ Erro também no sendMessage fallback:', fallbackError.message);
            throw fallbackError;
        }
    }
}

// === FUNÇÃO DE NORMALIZAÇÃO DE NÚMEROS DE TELEFONE ===
/**
 * Normaliza números de telefone removendo espaços, caracteres especiais e códigos de país
 * Suporta formatos:
 * - Internacional: +258 849 123 456, 258849123456
 * - Nacional: 849 123 456, 849123456
 * - Com formatação: (849) 123-456, 849-123-456
 * @param {string} numero - Número de telefone a normalizar
 * @returns {string} - Número normalizado (apenas dígitos, sem código de país)
 */
function normalizarNumeroTelefone(numero) {
    if (!numero) return '';

    // Remover todos os caracteres não numéricos
    let numeroLimpo = String(numero).replace(/[^0-9]/g, '');

    // Remover código de país 258 se presente
    if (numeroLimpo.startsWith('258') && numeroLimpo.length > 9) {
        numeroLimpo = numeroLimpo.substring(3);
    }

    // Garantir que temos pelo menos 9 dígitos
    if (numeroLimpo.length < 9) {
        return ''; // Número inválido
    }

    // Pegar os últimos 9 dígitos (formato moçambicano padrão)
    const numero9digitos = numeroLimpo.slice(-9);

    // Validar que é número Vodacom (começa com 84 ou 85)
    if (!numero9digitos.startsWith('84') && !numero9digitos.startsWith('85')) {
        return ''; // Não é Vodacom
    }

    return numero9digitos;
}

// Criar instância do cliente (SEGUINDO PADRÃO BOT1)
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "bot_retalho" // Simplificado como bot1
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection'
        ],
        timeout: 60000
    }
});

// === INICIALIZAR A IA ===
require('dotenv').config();
const ia = new WhatsAppAI(process.env.OPENAI_API_KEY);

// === SISTEMA DE PACOTES E BÔNUS (serão inicializados após WhatsApp conectar) ===
let sistemaPacotes = null;
let sistemaCompras = null;
let sistemaBonus = null;
let sistemaConfigGrupos = null;

// === LISTA DE BOTS PARA IGNORAR ===
// Adicione aqui nomes de bots que devem ser ignorados
const BOTS_IGNORADOS = [
    'safe',
    'bot safe',
    'safebot',
    'safe bot',
    'safeguard',
    'safeguard autodata',
    'autodata',
    'bot atacado',
    'bot retalho',
    'whatsapp bot',
    // Adicione mais nomes aqui conforme necessário
];

// Função para verificar se é bot ignorado
function ehBotIgnorado(contact) {
    const nomePushname = (contact.pushname || '').toLowerCase();
    const nomeContato = (contact.name || '').toLowerCase();

    return BOTS_IGNORADOS.some(botNome =>
        nomePushname.includes(botNome.toLowerCase()) ||
        nomeContato.includes(botNome.toLowerCase())
    );
}

// === SISTEMA ANTI-DUPLICATAS DE COMPROVANTES ===
// Cache de COMPROVANTES recentes para evitar processamento duplicado
const cacheComprovantesRecentes = new Map();
const CACHE_COMPROVANTE_TTL = 5 * 60 * 1000; // 5 minutos
const MAX_CACHE_SIZE = 500; // Máximo de comprovantes no cache

// Função para identificar se mensagem é um comprovante M-Pesa/E-Mola
function ehComprovante(conteudo) {
    if (!conteudo || typeof conteudo !== 'string') return false;

    const conteudoLower = conteudo.toLowerCase();

    // Padrões REAIS de comprovantes M-Pesa e E-Mola
    const iniciaComConfirmado = /^confirmado/i.test(conteudo);
    const contemIdTransacao = /id\s*da\s*transac[aã]o/i.test(conteudo);
    const contemTransferiste = /transferiste.*mt/i.test(conteudo);

    // É comprovante se:
    // 1. Inicia com "Confirmado" OU
    // 2. Contém "ID da transação" OU
    // 3. Contém "Transferiste X.XXMT"
    return iniciaComConfirmado || contemIdTransacao || contemTransferiste;
}

// Função para gerar hash único do comprovante
function gerarHashComprovante(remetente, conteudo) {
    // Normalizar conteúdo (remover espaços extras, quebras de linha, etc)
    const conteudoNormalizado = conteudo
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s@.-]/gi, '')
        .trim();

    return `${remetente}_${conteudoNormalizado}`;
}

// Função para verificar se COMPROVANTE é duplicado
function ehComprovanteDuplicado(remetente, conteudo) {
    // PRIMEIRO: Verificar se é um comprovante
    if (!ehComprovante(conteudo)) {
        // NÃO é comprovante, não controlar duplicatas
        return { duplicada: false, naoEhComprovante: true };
    }

    const hashComprovante = gerarHashComprovante(remetente, conteudo);
    const agora = Date.now();

    // Verificar se comprovante já foi processado recentemente
    const registro = cacheComprovantesRecentes.get(hashComprovante);

    if (registro && (agora - registro.timestamp < CACHE_COMPROVANTE_TTL)) {
        const tempoDecorrido = Math.floor((agora - registro.timestamp) / 1000);
        console.log(`⚠️ COMPROVANTE DUPLICADO: De ${remetente} já processado há ${tempoDecorrido}s`);
        return {
            duplicada: true,
            tempoDecorrido: tempoDecorrido,
            primeiroEnvio: registro.timestamp
        };
    }

    return { duplicada: false };
}

// Função para registrar comprovante processado
function registrarComprovanteProcessado(remetente, conteudo) {
    // Só registrar se for comprovante
    if (!ehComprovante(conteudo)) {
        return; // Não cachear mensagens normais
    }

    const hashComprovante = gerarHashComprovante(remetente, conteudo);

    // Adicionar ao cache
    cacheComprovantesRecentes.set(hashComprovante, {
        timestamp: Date.now(),
        remetente: remetente
    });

    // Limpar cache se estiver muito grande
    if (cacheComprovantesRecentes.size > MAX_CACHE_SIZE) {
        limparCacheComprovantesAntigos();
    }
}

// Função para limpar comprovantes antigos do cache
function limparCacheComprovantesAntigos() {
    const agora = Date.now();
    let removidos = 0;

    for (const [hash, registro] of cacheComprovantesRecentes.entries()) {
        if (agora - registro.timestamp > CACHE_COMPROVANTE_TTL) {
            cacheComprovantesRecentes.delete(hash);
            removidos++;
        }
    }

    if (removidos > 0) {
        console.log(`🧹 Cache de comprovantes limpo: ${removidos} comprovantes antigos removidos`);
    }

    // Se ainda estiver muito grande, remover as mais antigas
    if (cacheComprovantesRecentes.size > MAX_CACHE_SIZE) {
        const entries = Array.from(cacheComprovantesRecentes.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

        const paraRemover = entries.slice(0, cacheComprovantesRecentes.size - MAX_CACHE_SIZE);
        paraRemover.forEach(([hash]) => cacheComprovantesRecentes.delete(hash));

        console.log(`🧹 Cache adicional: ${paraRemover.length} comprovantes mais antigos removidos`);
    }
}

// Limpeza automática do cache a cada 10 minutos
setInterval(() => {
    limparCacheComprovantesAntigos();
}, 10 * 60 * 1000);

// REMOVIDO: Sistema de encaminhamento de mensagens
// (Movido para outro bot)

// === SISTEMA DE FILA ASSÍNCRONA DE MENSAGENS ===
class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.concurrency = 3; // Processar até 3 mensagens simultaneamente
        this.activeJobs = 0;
        this.maxQueueSize = 1000; // Limite da fila para evitar overflow
    }

    async add(messageData, handler) {
        if (this.queue.length >= this.maxQueueSize) {
            console.log(`⚠️ QUEUE: Fila cheia (${this.maxQueueSize}), descartando mensagem mais antiga`);
            this.queue.shift();
        }

        this.queue.push({ messageData, handler, timestamp: Date.now() });
        this.processQueue();
    }

    async processQueue() {
        if (this.processing || this.activeJobs >= this.concurrency || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0 && this.activeJobs < this.concurrency) {
            const job = this.queue.shift();
            this.activeJobs++;

            // Processar job em paralelo sem await
            this.processJob(job).finally(() => {
                this.activeJobs--;
                this.processQueue(); // Continuar processando
            });
        }

        this.processing = false;
    }

    async processJob(job) {
        try {
            const { messageData, handler, timestamp } = job;
            const waitTime = Date.now() - timestamp;

            if (waitTime > 30000) { // Descartar mensagens muito antigas (30s)
                console.log(`⏰ QUEUE: Mensagem descartada por timeout (${waitTime}ms)`);
                return;
            }

            smartLog(LOG_LEVEL.DEBUG, `📤 QUEUE: Processando mensagem (fila: ${this.queue.length}, ativos: ${this.activeJobs})`);
            await handler(messageData);

        } catch (error) {
            console.error(`❌ QUEUE: Erro ao processar mensagem:`, error);
        }
    }

    getStats() {
        return {
            queueSize: this.queue.length,
            activeJobs: this.activeJobs,
            processing: this.processing
        };
    }
}

const messageQueue = new MessageQueue();

// REMOVIDO: Fila de mensagens (sistema movido para outro bot)

// === SISTEMA DE CACHE DE DADOS OTIMIZADO COM CLEANUP AUTOMÁTICO ===
// === CACHE DE TRANSAÇÕES SIMPLIFICADO (SEGUINDO PADRÃO BOT1) ===
let cacheTransacoes = new Map();

// === CACHE DE PACOTES DIAMANTE PENDENTES (SISTEMA PARALELO) ===
let pacotesDiamantePendentes = {};
// Formato: {
//     'PP250924.1129': {
//         referencia: 'PP250924.1129',
//         numero: '842223344',
//         totalGB: 24,
//         gbDiamante: 11,
//         gbExtras: 13,
//         divisoes: ['PP250924.112901', 'PP250924.112902'],
//         confirmacoesRecebidas: [],
//         grupoId: '...',
//         grupoNome: '...',
//         timestamp: Date.now()
//     }
// }

// === SISTEMA DE RETRY SILENCIOSO PARA PAGAMENTOS ===
let pagamentosPendentes = {}; // {id: {dados do pedido}}
let timerRetryPagamentos = null;
const ARQUIVO_PAGAMENTOS_PENDENTES = './pagamentos_pendentes.json';
const RETRY_INTERVAL = 25000; // 25 segundos - verificação otimizada (planilha mantém apenas 48h de dados)
const RETRY_TIMEOUT = 5 * 60 * 1000; // 5 minutos - tempo máximo de tentativas
const MAX_RETRY_ATTEMPTS = 12; // 12 tentativas em 5 minutos (1 a cada 25s)

// === CONTROLE DE RATE LIMITING ===
let ultimaRequisicao = 0;
const DELAY_ENTRE_REQUISICOES = 500; // 500ms entre cada verificação (otimizado para API MariaDB local)
const MAX_REQUISICOES_POR_MINUTO = 60; // Aumentado para 60 req/min (MariaDB não tem rate limit)
let requisicoesUltimoMinuto = [];
let erros429Consecutivos = 0;
const MAX_ERROS_429 = 3; // Após 3 erros 429, pausar temporariamente
let timeoutSalvamentoPagamentos = null; // Timer para debounce de salvamento

// === SISTEMA DE REFERÊNCIAS E BÔNUS ===
let codigosReferencia = {}; // codigo -> dados do dono
let referenciasClientes = {}; // cliente -> dados da referencia
let bonusSaldos = {}; // cliente -> saldo e historico
let pedidosSaque = {}; // referencia -> dados do pedido
let membrosEntrada = {}; // {grupoId: {memberId: dataEntrada}}

// Arquivos de persistência
const ARQUIVO_REFERENCIAS = './dados_referencias.json';
const ARQUIVO_BONUS = './dados_bonus.json';
const ARQUIVO_CODIGOS = './dados_codigos.json';
const ARQUIVO_SAQUES = './dados_saques.json';
const ARQUIVO_MEMBROS = './dados_membros_entrada.json';

// === FUNÇÕES DO SISTEMA DE REFERÊNCIA ===

let ultimosParticipantes = {}; // {grupoId: [participantIds]} - cache dos participantes

// === CACHE PARA RASTREAR MEMBROS JÁ PROCESSADOS VIA GROUP-JOIN ===
let membrosProcessadosViaEvent = new Set(); // Evita processamento duplicado

// Sistema automático de detecção de novos membros
async function iniciarMonitoramentoMembros() {
    console.log('⏸️ Monitoramento automático de novos membros está DESATIVADO');
    // Função desativada completamente - não faz nada
    return;
}

// Verificar novos membros em todos os grupos monitorados
async function verificarNovosMembros() {
    for (const grupoId of Object.keys(CONFIGURACAO_GRUPOS)) {
        try {
            await detectarNovosMembrosGrupo(grupoId);
        } catch (error) {
            // Silencioso para não poluir logs
        }
    }
}

// Detectar novos membros em um grupo específico
async function detectarNovosMembrosGrupo(grupoId) {
    try {
        const chat = await client.getChatById(grupoId);
        const participants = await chat.participants;
        const participantIds = participants.map(p => p.id._serialized);
        
        // Se é a primeira vez que verificamos este grupo
        if (!ultimosParticipantes[grupoId]) {
            ultimosParticipantes[grupoId] = participantIds;
            return;
        }
        
        // Encontrar novos participantes
        const novosParticipantes = participantIds.filter(id => 
            !ultimosParticipantes[grupoId].includes(id)
        );
        
        // Processar novos membros
        for (const participantId of novosParticipantes) {
            await processarNovoMembro(grupoId, participantId);
        }
        
        // Atualizar cache
        ultimosParticipantes[grupoId] = participantIds;
        
    } catch (error) {
        // Silencioso - grupo pode não existir ou bot não ter acesso
    }
}

// Processar novo membro detectado
async function processarNovoMembro(grupoId, participantId) {
    try {
        const configGrupo = getConfiguracaoGrupo(grupoId);
        if (!configGrupo) return;

        console.log(`👋 Novo membro detectado via POLLING: ${participantId}`);

        // Verificar se já foi processado via event 'group-join'
        const membroKey = `${grupoId}_${participantId}`;
        if (membrosProcessadosViaEvent.has(membroKey)) {
            console.log(`✅ Membro ${participantId} já foi processado via event 'group-join' - pulando...`);
            return;
        }

        // SISTEMA AUTOMÁTICO DESATIVADO - Usuário deve usar código manual
        console.log(`📢 Sistema automático desativado - novo membro deve usar código do convidador`);

        // Registrar entrada do membro
        await registrarEntradaMembro(grupoId, participantId);

    } catch (error) {
        console.error('❌ Erro ao processar novo membro:', error);
    }
}

// SISTEMA DE DETECÇÃO INTELIGENTE - CORRIGIDO
async function tentarDetectarConvidador(grupoId, novoMembroId) {
    try {
        console.log(`🔍 DETECÇÃO: Analisando quem adicionou ${novoMembroId}...`);

        const chat = await client.getChatById(grupoId);
        const participants = await chat.participants;

        // 1. ESTRATÉGIA: Filtrar participantes que estão na lista ADMINISTRADORES_GLOBAIS
        const admins = participants.filter(p => {
            // Verificar se o ID está diretamente na lista
            if (ADMINISTRADORES_GLOBAIS.includes(p.id._serialized)) return true;
            // Se for @lid, verificar se está mapeado
            if (p.id._serialized.includes('@lid') && MAPEAMENTO_IDS[p.id._serialized]) {
                return ADMINISTRADORES_GLOBAIS.includes(MAPEAMENTO_IDS[p.id._serialized]);
            }
            return false;
        }).filter(p => p.id._serialized !== novoMembroId);

        if (admins.length === 0) {
            console.log(`❌ DETECÇÃO: Nenhum admin da lista encontrado no grupo`);
            return null;
        }

        // 2. LÓGICA INTELIGENTE: Buscar o admin mais provável
        const hojeISO = new Date().toISOString().split('T')[0];

        // Verificar quantas referências cada admin criou hoje
        const adminStats = admins.map(admin => {
            const adminId = admin.id._serialized;
            const referenciasHoje = Object.keys(referenciasClientes).filter(clienteId => {
                const ref = referenciasClientes[clienteId];
                return ref.convidadoPor === adminId && ref.dataRegistro?.startsWith(hojeISO);
            }).length;

            return { adminId, referenciasHoje, nome: admin.pushname || 'Admin' };
        });

        // Ordenar por menos referências criadas (mais justo distribuir)
        adminStats.sort((a, b) => a.referenciasHoje - b.referenciasHoje);

        // 3. REGRAS DE SELEÇÃO INTELIGENTE:
        const adminEscolhido = adminStats[0];

        // Se o admin com menos referências tem muito poucas (0-2), é um bom candidato
        if (adminEscolhido.referenciasHoje <= 2) {
            console.log(`🎯 DETECÇÃO: Selecionado ${adminEscolhido.nome} (${adminEscolhido.referenciasHoje} refs hoje)`);
            return await criarReferenciaAutomaticaInteligente(adminEscolhido.adminId, novoMembroId, grupoId);
        }

        // Se todos os admins já têm muitas referências, usar distribuição rotativa
        console.log(`⚖️ DETECÇÃO: Usando distribuição rotativa entre admins`);
        return await criarReferenciaAutomaticaInteligente(adminEscolhido.adminId, novoMembroId, grupoId);

        /* CÓDIGO ANTIGO COMENTADO - CAUSAVA FALSAS REFERÊNCIAS
        const chat = await client.getChatById(grupoId);
        const participants = await chat.participants;
        const admins = participants.filter(p => p.isAdmin && p.id._serialized !== novoMembroId);

        if (admins.length > 0) {
            const possivelConvidador = admins[0].id._serialized;
            console.log(`🎯 BACKUP: Assumindo que ${possivelConvidador} adicionou ${novoMembroId}`);

            const hojeISO = new Date().toISOString().split('T')[0];
            const referenciasHoje = Object.keys(referenciasClientes).filter(clienteId => {
                const ref = referenciasClientes[clienteId];
                return ref.convidadoPor === possivelConvidador &&
                       ref.dataRegistro?.startsWith(hojeISO);
            }).length;

            if (referenciasHoje >= 5) {
                console.log(`⚠️ BACKUP: ${possivelConvidador} já tem ${referenciasHoje} referências hoje, pulando...`);
                return false;
            }

            const resultado = await criarReferenciaAutomaticaBackup(possivelConvidador, novoMembroId, grupoId);
            console.log(`🔗 BACKUP: Resultado da criação: ${resultado ? 'SUCESSO' : 'FALHOU'}`);

            return resultado;
        } else {
            console.log(`❌ BACKUP: Nenhum admin encontrado no grupo`);
            return false;
        }
        */

    } catch (error) {
        console.error('❌ Erro ao tentar detectar convidador (backup):', error);
        return null;
    }
}

// === DETECÇÃO DE CONVIDADOR VIA ANÁLISE DE MENSAGENS ===
async function detectarConvidadorViaMensagens(grupoId, novoMembroId) {
    try {
        console.log(`🔍 ANÁLISE: Detectando convidador via mensagens para ${novoMembroId}...`);

        // Obter histórico de mensagens recentes do grupo (últimos 10 minutos)
        const chat = await client.getChatById(grupoId);
        const agora = Date.now();
        const limiteTempo = agora - (10 * 60 * 1000); // 10 minutos atrás

        // Buscar mensagens recentes
        const mensagens = await chat.fetchMessages({ limit: 100 });
        console.log(`📜 Analisando ${mensagens.length} mensagens recentes...`);

        let convidadorDetectado = null;
        let confiabilidade = 0;

        // 1. PRIORIDADE MÁXIMA: Buscar mensagens de sistema do WhatsApp
        for (const mensagem of mensagens) {
            // Pular mensagens antigas
            if (mensagem.timestamp * 1000 < limiteTempo) {
                continue;
            }

            // Buscar mensagens de sistema (aqueles placeholders cinzentos)
            const isSistema = mensagem.type === 'notification' ||
                             mensagem.type === 'group_notification' ||
                             mensagem.type === 'GROUP_NOTIFICATION' ||
                             mensagem.type === 'NOTIFICATION';

            if (isSistema || (mensagem.body && (mensagem.body.includes('adicionou') || mensagem.body.includes('added')))) {
                console.log(`🔔 NOTIFICAÇÃO SISTEMA:`, {
                    type: mensagem.type,
                    body: mensagem.body,
                    author: mensagem.author,
                    timestamp: new Date(mensagem.timestamp * 1000).toLocaleString()
                });

                // Tentar extrair quem adicionou da mensagem do sistema
                if (mensagem.body) {
                    const nomeNovoMembro = await obterNomeContato(novoMembroId);

                    // Padrões mais abrangentes para detectar adição
                    const padroesAdicao = [
                        new RegExp(`([\\w\\s]+)\\s+(adicionou|added)\\s+.*${nomeNovoMembro.split(' ')[0]}`, 'i'),
                        new RegExp(`([\\w\\s]+)\\s+(adicionou|added)\\s+.*${nomeNovoMembro}`, 'i'),
                        new RegExp(`(.+)\\s+(adicionou|added)\\s+(.+)`, 'i') // Padrão genérico
                    ];

                    for (const regex of padroesAdicao) {
                        const match = mensagem.body.match(regex);
                        if (match) {
                            const nomeConvidador = match[1].trim();
                            console.log(`🎯 SISTEMA DETECTOU: "${nomeConvidador}" adicionou "${match[3] || nomeNovoMembro}"`);

                            // Buscar ID do convidador pelos participantes
                            const participants = chat.participants;
                            for (const participant of participants) {
                                const nomeParticipante = await obterNomeContato(participant.id._serialized);

                                // Comparação flexível de nomes
                                const nomeParticipanteLimpo = nomeParticipante.toLowerCase().trim();
                                const nomeConvidadorLimpo = nomeConvidador.toLowerCase().trim();

                                if ((nomeParticipanteLimpo.includes(nomeConvidadorLimpo) ||
                                     nomeConvidadorLimpo.includes(nomeParticipanteLimpo)) &&
                                    isAdministrador(participant.id._serialized)) {

                                    convidadorDetectado = participant.id._serialized;
                                    confiabilidade = 95; // Altíssima confiabilidade para mensagens do sistema
                                    console.log(`🎯 CONFIRMADO VIA SISTEMA: ${nomeParticipante} (${convidadorDetectado})`);
                                    break;
                                }
                            }

                            if (convidadorDetectado) break;
                        }
                    }
                }
            }

            if (convidadorDetectado) break;
        }

        // 2. SEGUNDO MÉTODO: Buscar padrões de convite nas mensagens de usuários
        if (!convidadorDetectado) {
            for (const mensagem of mensagens) {
                if (mensagem.timestamp * 1000 < limiteTempo) continue;

                const autorMensagem = mensagem.author || mensagem.from;
                const corpo = mensagem.body.toLowerCase();

                // Buscar padrões de convite nas mensagens
                const padroesFrases = [
                    /vou adicionar/i,
                    /vou convidar/i,
                    /vou chamar/i,
                    /adicionei/i,
                    /convidei/i,
                    /chamei/i,
                    /entrem?\s+no\s+grupo/i,
                    /venham?\s+para\s+o\s+grupo/i,
                    /grupo\s+novo/i
                ];

                for (const padrao of padroesFrases) {
                    if (padrao.test(corpo)) {
                        console.log(`💡 PADRÃO DETECTADO: "${corpo.substring(0, 50)}..." por ${autorMensagem}`);

                        const isAdmin = isAdministrador(autorMensagem);
                        if (isAdmin) {
                            convidadorDetectado = autorMensagem;
                            confiabilidade = 75; // Boa confiabilidade para padrões + admin
                            console.log(`🎯 DETECTADO VIA PADRÃO: ${autorMensagem} (confiabilidade: ${confiabilidade}%)`);
                            break;
                        }
                    }
                }

                if (convidadorDetectado) break;
            }
        }

        // 3. FALLBACK: Distribuição inteligente
        if (!convidadorDetectado) {
            console.log(`🧠 Usando distribuição inteligente como backup...`);
            convidadorDetectado = await selecionarAdminComMenosReferencias(grupoId);
            confiabilidade = 50; // Confiabilidade média para distribuição inteligente
        }

        if (convidadorDetectado) {
            console.log(`✅ DETECTADO: ${convidadorDetectado} (confiabilidade: ${confiabilidade}%)`);

            // Criar referência automática com método identificado
            const resultado = await criarReferenciaAutomaticaInteligente(
                convidadorDetectado,
                novoMembroId,
                grupoId
            );

            if (resultado) {
                // Adicionar indicador de método de detecção
                const referencia = referenciasClientes[novoMembroId];
                if (referencia) {
                    referencia.metodoDeteccao = 'AUTO_ANALISE_MENSAGENS';
                    referencia.confiabilidade = confiabilidade;

                    console.log(`🎯 ANÁLISE: Referência criada com ${confiabilidade}% de confiabilidade`);
                }
            }

            return resultado;
        } else {
            console.log(`❌ ANÁLISE: Não foi possível detectar convidador`);
            return false;
        }

    } catch (error) {
        console.error('❌ Erro na análise de mensagens:', error);
        return false;
    }
}

// === FUNÇÃO AUXILIAR PARA OBTER NOME DE CONTATO ===
async function obterNomeContato(contactId) {
    try {
        const contact = await client.getContactById(contactId);
        return contact.pushname || contact.name || contact.number || 'Desconhecido';
    } catch (error) {
        console.error(`❌ Erro ao obter nome do contato ${contactId}:`, error);
        return 'Desconhecido';
    }
}

// === SELEÇÃO INTELIGENTE DE ADMIN COM MENOS REFERÊNCIAS ===
async function selecionarAdminComMenosReferencias(grupoId) {
    try {
        const chat = await client.getChatById(grupoId);
        const participants = chat.participants;

        // Filtrar apenas admins da lista ADMINISTRADORES_GLOBAIS
        const admins = participants.filter(p => {
            if (ADMINISTRADORES_GLOBAIS.includes(p.id._serialized)) return true;
            if (p.id._serialized.includes('@lid') && MAPEAMENTO_IDS[p.id._serialized]) {
                return ADMINISTRADORES_GLOBAIS.includes(MAPEAMENTO_IDS[p.id._serialized]);
            }
            return false;
        });
        if (admins.length === 0) {
            console.log(`❌ Nenhum admin da lista encontrado no grupo`);
            return null;
        }

        console.log(`👥 DISTRIBUIÇÃO: Analisando ${admins.length} admins...`);

        // Contar referências criadas hoje por cada admin
        const hoje = new Date().toDateString();
        const contadorReferencias = {};

        // Inicializar contador para todos os admins
        admins.forEach(admin => {
            contadorReferencias[admin.id._serialized] = 0;
        });

        // Contar referências existentes
        Object.values(referenciasClientes).forEach(ref => {
            if (ref.dataReferencia && new Date(ref.dataReferencia).toDateString() === hoje) {
                if (contadorReferencias.hasOwnProperty(ref.convidadoPor)) {
                    contadorReferencias[ref.convidadoPor]++;
                }
            }
        });

        // Encontrar admin com menos referências
        let adminSelecionado = null;
        let menorContador = Infinity;

        for (const [adminId, contador] of Object.entries(contadorReferencias)) {
            console.log(`📊 Admin ${adminId}: ${contador} referências hoje`);
            if (contador < menorContador) {
                menorContador = contador;
                adminSelecionado = adminId;
            }
        }

        if (adminSelecionado) {
            console.log(`🎯 SELECIONADO: ${adminSelecionado} (${menorContador} referências hoje)`);
        }

        return adminSelecionado;

    } catch (error) {
        console.error('❌ Erro ao selecionar admin:', error);
        return null;
    }
}

// === CRIAÇÃO DE REFERÊNCIA AUTOMÁTICA INTELIGENTE ===
async function criarReferenciaAutomaticaInteligente(convidadorId, convidadoId, grupoId) {
    try {
        console.log(`🤖 INTELIGENTE: Criando referência automática: ${convidadorId} → ${convidadoId}`);

        // Verificar se o convidado já tem referência
        if (referenciasClientes[convidadoId]) {
            console.log(`   ⚠️ INTELIGENTE: Cliente ${convidadoId} já tem referência registrada`);
            return false;
        }

        // Obter nomes para logs mais claros
        let nomeConvidador = convidadorId;
        let nomeConvidado = convidadoId;

        try {
            const contactConvidador = await client.getContactById(convidadorId);
            const contactConvidado = await client.getContactById(convidadoId);
            nomeConvidador = contactConvidador.pushname || contactConvidador.name || convidadorId;
            nomeConvidado = contactConvidado.pushname || contactConvidado.name || convidadoId;
        } catch (error) {
            console.log(`   ⚠️ Não foi possível obter nomes dos contatos`);
        }

        // Gerar código único
        const codigo = gerarCodigoReferencia(convidadorId);

        // CORRIGIDO: Registrar código ANTES da referência do cliente (ESTRUTURA PADRONIZADA)
        codigosReferencia[codigo] = {
            dono: convidadorId, // CORRIGIDO: usar 'dono' em vez de salvar só o ID
            nome: nomeConvidador,
            criado: new Date().toISOString(),
            ativo: true,
            usado: true,
            usadoPor: convidadoId,
            dataUso: new Date().toISOString(),
            automatico: true,
            metodoDeteccao: 'AUTO_INTELIGENTE'
        };

        // Criar referência com indicação de detecção automática
        referenciasClientes[convidadoId] = {
            codigo: codigo,
            convidadoPor: convidadorId,
            nomeConvidador: nomeConvidador,
            nomeConvidado: nomeConvidado,
            dataRegistro: new Date().toISOString(),
            grupo: grupoId,
            comprasRealizadas: 0,
            bonusTotal: 0,
            metodoDeteccao: 'AUTO_INTELIGENTE', // Indicação especial
            obs: 'Referência criada por detecção automática inteligente'
        };

        console.log(`   ✅ INTELIGENTE: Referência criada: ${codigo} (${nomeConvidador} → ${nomeConvidado})`);

        // CORRIGIDO: Inicializar saldo de bônus do convidador
        if (!bonusSaldos[convidadorId]) {
            bonusSaldos[convidadorId] = {
                saldo: 0,
                detalhesReferencias: {},
                historicoSaques: [],
                totalReferencias: 0
            };
        }

        // Salvar dados
        agendarSalvamento();

        // Enviar notificação ao convidador com indicação de auto-detecção
        try {
            const mensagemNotificacao = `🤖 *REFERÊNCIA AUTOMÁTICA CRIADA*

🎯 **Código:** ${codigo}
👤 **Novo cliente:** ${nomeConvidado}
📅 **Data:** ${new Date().toLocaleDateString('pt-PT')}

⚠️ *Esta referência foi criada automaticamente*
Se não foi você quem convidou este membro, digite *.cancelar ${codigo}* para cancelar.

💰 Ganhe 200MB a cada compra deles (até 5 compras = 1GB)!`;

            await client.sendMessage(convidadorId, mensagemNotificacao);
            console.log(`   ✅ INTELIGENTE: Notificação enviada ao convidador`);
        } catch (error) {
            console.error(`   ❌ Erro ao enviar notificação:`, error);
        }

        return true;

    } catch (error) {
        console.error('❌ Erro ao criar referência automática inteligente:', error);
        return false;
    }
}

// Versão backup da criação de referência (com indicação de incerteza) - DEPRECATED
async function criarReferenciaAutomaticaBackup(convidadorId, convidadoId, grupoId) {
    try {
        console.log(`🔗 BACKUP: Criando referência automática: ${convidadorId} → ${convidadoId}`);

        // Verificar se o convidado já tem referência
        if (referenciasClientes[convidadoId]) {
            console.log(`   ⚠️ BACKUP: Cliente ${convidadoId} já tem referência registrada`);
            return false;
        }

        // Verificar se o convidador não está tentando convidar a si mesmo
        if (convidadorId === convidadoId) {
            console.log(`   ❌ BACKUP: Convidador tentou convidar a si mesmo`);
            return false;
        }

        // Gerar código único para esta referência
        const codigo = gerarCodigoReferencia(convidadorId);

        // Registrar código de referência (ESTRUTURA PADRONIZADA)
        codigosReferencia[codigo] = {
            dono: convidadorId, // CORRIGIDO: usar 'dono' em vez de 'criador'
            nome: 'AutoBackup', // Nome simplificado para referências backup
            criado: new Date().toISOString(),
            ativo: true,
            usado: true,
            usadoPor: convidadoId,
            dataUso: new Date().toISOString(),
            automatico: true,
            backup: true // Marcar como detectado por sistema backup
        };

        // Registrar referência do cliente
        referenciasClientes[convidadoId] = {
            codigo: codigo,
            convidadoPor: convidadorId,
            dataRegistro: new Date().toISOString(),
            comprasRealizadas: 0,
            automatico: true,
            backup: true // Marcar como detectado por sistema backup
        };

        // Inicializar saldo de bônus do convidador se não existir
        if (!bonusSaldos[convidadorId]) {
            bonusSaldos[convidadorId] = {
                saldo: 0,
                detalhesReferencias: {},
                historicoSaques: [],
                totalReferencias: 0
            };
        }

        // Incrementar total de referências
        bonusSaldos[convidadorId].totalReferencias++;

        // Inicializar detalhes da referência
        bonusSaldos[convidadorId].detalhesReferencias[convidadoId] = {
            compras: 0,
            bonusGanho: 0,
            codigo: codigo,
            ativo: true,
            automatico: true,
            backup: true
        };

        // CORRIGIDO: Salvar dados (reativar salvamento para persistir referências)
        agendarSalvamento();

        // Obter nomes dos participantes para notificação
        const nomeConvidador = await obterNomeContato(convidadorId);
        const nomeConvidado = await obterNomeContato(convidadoId);

        // Enviar notificação no grupo (com indicação de estimativa)
        try {
            // CORRIGIDO: Remover @lid e @c.us das menções
            const convidadorLimpo = convidadorId.replace('@c.us', '').replace('@lid', '');
            const convidadoLimpo = convidadoId.replace('@c.us', '').replace('@lid', '');

            await client.sendMessage(grupoId,
                `🎉 *NOVO MEMBRO ADICIONADO!*\n\n` +
                `👋 Bem-vindo @${convidadoLimpo}!\n\n` +
                `📢 Sistema detectou provável adição por: @${convidadorLimpo}\n` +
                `🎁 @${convidadorLimpo} ganhará *200MB* a cada compra de @${convidadoLimpo}!\n\n` +
                `📋 *Benefícios:*\n` +
                `• Máximo: 5 compras = 1000MB (1GB)\n` +
                `• Saque mínimo: 1000MB\n` +
                `• Sistema automático ativo!\n\n` +
                `💡 _Continue convidando amigos para ganhar mais bônus!_\n` +
                `⚠️ _Detecção automática por monitoramento do sistema_`, {
                mentions: [convidadorId, convidadoId]
            });

            console.log(`✅ BACKUP: Notificação de referência automática enviada`);
        } catch (error) {
            console.error('❌ BACKUP: Erro ao enviar notificação de referência:', error);
        }

        console.log(`✅ BACKUP: Referência automática criada: ${codigo} (${nomeConvidador} → ${nomeConvidado})`);

        return {
            codigo: codigo,
            convidador: convidadorId,
            convidado: convidadoId,
            automatico: true,
            backup: true
        };

    } catch (error) {
        console.error('❌ BACKUP: Erro ao criar referência automática:', error);
        return false;
    }
}

// Detectar novo membro pela primeira mensagem (backup)
async function detectarNovoMembro(grupoId, participantId, configGrupo) {
    // Esta função agora é só um backup caso o monitoramento automático falhe
    return;
}

// Registrar entrada de novo membro
async function registrarEntradaMembro(grupoId, participantId) {
    try {
        if (!membrosEntrada[grupoId]) {
            membrosEntrada[grupoId] = {};
        }
        
        membrosEntrada[grupoId][participantId] = new Date().toISOString();
        await salvarDadosMembros();
        
        console.log(`📝 Entrada registrada`);
    } catch (error) {
        console.error('❌ Erro ao registrar entrada de membro:', error);
    }
}

// Salvar dados de membros
async function salvarDadosMembros() {
    try {
        await fs.writeFile(ARQUIVO_MEMBROS, JSON.stringify(membrosEntrada));
    } catch (error) {
        console.error('❌ Erro ao salvar dados de membros:', error);
    }
}


// Verificar se usuário é elegível para usar código (últimos 5 dias)
function isElegivelParaCodigo(participantId, grupoId) {
    try {
        // CORRIGIDO: Se não tem registro, ASSUMIR que é novo membro (elegível)
        if (!membrosEntrada[grupoId] || !membrosEntrada[grupoId][participantId]) {
            console.log(`✅ Membro sem registro de entrada - ASSUMINDO NOVO MEMBRO (elegível)`);

            // Registrar automaticamente agora
            if (!membrosEntrada[grupoId]) {
                membrosEntrada[grupoId] = {};
            }
            membrosEntrada[grupoId][participantId] = new Date().toISOString();

            return true; // CORRIGIDO: Novo membro É elegível
        }

        const dataEntrada = new Date(membrosEntrada[grupoId][participantId]);
        const agora = new Date();
        const limite5Dias = 5 * 24 * 60 * 60 * 1000; // 5 dias em ms

        const tempoNoGrupo = agora - dataEntrada;
        const diasNoGrupo = Math.floor(tempoNoGrupo / (24 * 60 * 60 * 1000));
        const elegivelTempo = tempoNoGrupo <= limite5Dias;

        console.log(`🔍 Verificando elegibilidade - ${diasNoGrupo} dias no grupo - ${elegivelTempo ? 'ELEGÍVEL' : 'NÃO ELEGÍVEL'}`);

        return elegivelTempo;
    } catch (error) {
        console.error('❌ Erro ao verificar elegibilidade:', error);
        // CORRIGIDO: Em caso de erro, permitir (dar benefício da dúvida)
        return true;
    }
}

// Carregar dados persistentes
async function carregarDadosReferencia() {
    try {
        // Carregar códigos
        try {
            const dados = await fs.readFile(ARQUIVO_CODIGOS, 'utf8');
            codigosReferencia = JSON.parse(dados);
            console.log(`📋 ${Object.keys(codigosReferencia).length} códigos de referência carregados`);

            // LOGS DETALHADOS para debug
            if (Object.keys(codigosReferencia).length > 0) {
                console.log(`🔍 Códigos carregados:`);
                Object.entries(codigosReferencia).forEach(([codigo, dados]) => {
                    console.log(`   - ${codigo} → Dono: ${dados.dono} (${dados.nome})`);
                });
            }
        } catch (e) {
            console.log(`⚠️ Arquivo de códigos não encontrado, criando novo: ${e.message}`);
            codigosReferencia = {};
        }

        // Carregar referências  
        try {
            const dados = await fs.readFile(ARQUIVO_REFERENCIAS, 'utf8');
            referenciasClientes = JSON.parse(dados);
            console.log(`👥 ${Object.keys(referenciasClientes).length} referências de clientes carregadas`);
        } catch (e) {
            referenciasClientes = {};
        }

        // Carregar bônus
        try {
            const dados = await fs.readFile(ARQUIVO_BONUS, 'utf8');
            bonusSaldos = JSON.parse(dados);
            console.log(`💰 ${Object.keys(bonusSaldos).length} saldos de bônus carregados`);
        } catch (e) {
            bonusSaldos = {};
        }

        // Carregar saques
        try {
            const dados = await fs.readFile(ARQUIVO_SAQUES, 'utf8');
            pedidosSaque = JSON.parse(dados);
            console.log(`🏦 ${Object.keys(pedidosSaque).length} pedidos de saque carregados`);
        } catch (e) {
            pedidosSaque = {};
        }

        // Carregar dados de entrada de membros
        try {
            const dados = await fs.readFile(ARQUIVO_MEMBROS, 'utf8');
            membrosEntrada = JSON.parse(dados);
            console.log(`👥 ${Object.keys(membrosEntrada).length} grupos com dados de entrada carregados`);
        } catch (e) {
            membrosEntrada = {};
        }

    } catch (error) {
        console.error('❌ Erro ao carregar dados de referência:', error);
    }
}

// Salvar dados persistentes
// === SISTEMA DE SALVAMENTO OTIMIZADO ===
let salvamentoPendente = false;

async function salvarDadosReferencia() {
    // Evitar salvamentos simultâneos
    if (salvamentoPendente) {
        console.log(`⏳ Salvamento já em andamento, aguardando...`);
        return;
    }
    salvamentoPendente = true;

    console.log(`💾 Iniciando salvamento de dados de referência...`);
    console.log(`   - Códigos: ${Object.keys(codigosReferencia).length} registros`);
    console.log(`   - Referências: ${Object.keys(referenciasClientes).length} registros`);
    console.log(`   - Bônus: ${Object.keys(bonusSaldos).length} registros`);
    console.log(`   - Saques: ${Object.keys(pedidosSaque).length} registros`);

    try {
        // Usar Promise.allSettled para não falhar se um arquivo der erro
        const resultados = await Promise.allSettled([
            fs.writeFile(ARQUIVO_CODIGOS, JSON.stringify(codigosReferencia)),
            fs.writeFile(ARQUIVO_REFERENCIAS, JSON.stringify(referenciasClientes)),
            fs.writeFile(ARQUIVO_BONUS, JSON.stringify(bonusSaldos)),
            fs.writeFile(ARQUIVO_SAQUES, JSON.stringify(pedidosSaque))
        ]);

        // Log detalhado de cada salvamento
        const nomeArquivos = ['ARQUIVO_CODIGOS', 'ARQUIVO_REFERENCIAS', 'ARQUIVO_BONUS', 'ARQUIVO_SAQUES'];
        resultados.forEach((resultado, index) => {
            if (resultado.status === 'fulfilled') {
                console.log(`   ✅ ${nomeArquivos[index]} salvo com sucesso`);
            } else {
                console.error(`   ❌ ${nomeArquivos[index]} FALHOU:`, resultado.reason);
            }
        });

        const falhas = resultados.filter(r => r.status === 'rejected');
        if (falhas.length > 0) {
            console.error(`❌ Total de falhas: ${falhas.length}/${resultados.length}`);
        } else {
            console.log(`✅ Todos os arquivos salvos com sucesso!`);
        }
    } catch (error) {
        console.error('❌ Erro crítico ao salvar dados de referência:', error);
    } finally {
        salvamentoPendente = false;
    }
}

// Função para agendar salvamento com debounce
let timeoutSalvamento = null;

function agendarSalvamento() {
    if (timeoutSalvamento) {
        clearTimeout(timeoutSalvamento);
    }

    timeoutSalvamento = setTimeout(async () => {
        await salvarDadosReferencia();
        timeoutSalvamento = null;
    }, 3000); // 3 segundos de debounce
}

// Função para buscar saldo de bônus em todos os formatos possíveis
async function buscarSaldoBonus(userId) {
    // Usar sistemaBonus se disponível
    if (sistemaBonus) {
        return sistemaBonus.buscarSaldo(userId);
    }

    // Fallback para método antigo (caso sistemaBonus não esteja inicializado)
    console.log(`\n🔍 === BUSCA DE SALDO DETALHADA ===`);
    console.log(`📱 Buscando saldo para userId: "${userId}"`);

    // Tentar formato exato primeiro
    if (bonusSaldos[userId]) {
        console.log(`✅ Encontrado no formato exato: ${userId} (${bonusSaldos[userId].saldo}MB)`);
        return bonusSaldos[userId];
    }
    console.log(`❌ Não encontrado no formato exato: ${userId}`);

    // Extrair número base (sem sufixos)
    const numeroBase = userId.replace('@c.us', '').replace('@lid', '');
    console.log(`🔢 Número base extraído: "${numeroBase}"`);

    // Tentar todos os formatos possíveis
    const formatosPossiveis = [
        numeroBase,
        `${numeroBase}@c.us`,
        `${numeroBase}@lid`
    ];

    console.log(`🔍 Testando ${formatosPossiveis.length} formatos possíveis:`);
    for (const formato of formatosPossiveis) {
        console.log(`   - Testando: "${formato}"`);
        if (bonusSaldos[formato]) {
            console.log(`   ✅ ENCONTRADO! Formato: ${formato}, Saldo: ${bonusSaldos[formato].saldo}MB`);
            return bonusSaldos[formato];
        } else {
            console.log(`   ❌ Não encontrado`);
        }
    }

    // BUSCA AVANÇADA: Tentar obter número real do contato
    console.log(`🔍 Tentando busca avançada via número real do contato...`);
    try {
        const contact = await client.getContactById(userId);
        if (contact && contact.number) {
            console.log(`📞 Número real encontrado: ${contact.number}`);
            const numeroReal = contact.number;

            // Tentar com o número real
            const formatosReais = [
                numeroReal,
                `${numeroReal}@c.us`,
                `${numeroReal}@lid`
            ];

            for (const formato of formatosReais) {
                if (bonusSaldos[formato]) {
                    console.log(`   ✅ ENCONTRADO via número real! Formato: ${formato}, Saldo: ${bonusSaldos[formato].saldo}MB`);
                    return bonusSaldos[formato];
                }
            }
        }
    } catch (error) {
        console.log(`⚠️ Erro ao buscar contato: ${error.message}`);
    }

    console.log(`❌ Saldo não encontrado em nenhum formato`);
    console.log(`📋 Saldos existentes no sistema (primeiros 10):`);
    const chaves = Object.keys(bonusSaldos).slice(0, 10);
    chaves.forEach(chave => {
        console.log(`   • ${chave}: ${bonusSaldos[chave].saldo}MB`);
    });

    return null;
}

// Função para atualizar saldo em todos os formatos existentes
async function atualizarSaldoBonus(userId, operacao) {
    // Usar sistemaBonus se disponível
    if (sistemaBonus) {
        await sistemaBonus.atualizarSaldo(userId, operacao);
        return;
    }

    // Fallback para método antigo
    const numeroBase = userId.replace('@c.us', '').replace('@lid', '');
    const formatosPossiveis = [
        numeroBase,
        `${numeroBase}@c.us`,
        `${numeroBase}@lid`
    ];

    let atualizado = 0;
    for (const formato of formatosPossiveis) {
        if (bonusSaldos[formato]) {
            operacao(bonusSaldos[formato]);
            atualizado++;
        }
    }

    // Se não encontrou em nenhum formato padrão, fazer busca avançada
    if (atualizado === 0) {
        console.log(`🔍 Formato ${userId} não encontrado, tentando busca avançada...`);
        try {
            const contact = await client.getContactById(userId);
            if (contact && contact.number) {
                const numeroReal = contact.number;
                const formatosReais = [
                    numeroReal,
                    `${numeroReal}@c.us`,
                    `${numeroReal}@lid`
                ];

                for (const formato of formatosReais) {
                    if (bonusSaldos[formato]) {
                        console.log(`   ✅ ENCONTRADO via número real! Formato: ${formato}`);
                        operacao(bonusSaldos[formato]);
                        atualizado++;
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Erro na busca avançada para atualização:`, error.message);
        }
    }

    console.log(`💾 Saldo atualizado em ${atualizado} formato(s)`);
    return atualizado > 0;
}

// === CACHE DE TRANSAÇÕES (SEM ARQUIVOS .TXT) ===
function adicionarTransacaoCache(dados, grupoId) {
    const key = `${grupoId}_${Date.now()}_${Math.random()}`;
    cacheTransacoes.set(key, {
        ...dados,
        timestamp: Date.now(),
        grupo_id: grupoId
    });

    // Limpar cache automaticamente (manter últimas 100 transações)
    if (cacheTransacoes.size > 100) {
        const keys = Array.from(cacheTransacoes.keys());
        const oldKeys = keys.slice(0, keys.length - 100);
        oldKeys.forEach(key => cacheTransacoes.delete(key));
    }
}

// Gerar código único
function gerarCodigoReferencia(remetente) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codigo;
    do {
        codigo = '';
        for (let i = 0; i < 6; i++) {
            codigo += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (codigosReferencia[codigo]);
    
    return codigo;
}

// Processar bônus de compra
async function processarBonusCompra(remetenteCompra, valorCompra, grupoId = null) {
    console.log(`🎁 Verificando bônus para compra`);

    // CORRIGIDO: Usar sistemaBonus se disponível (método robusto e persistente)
    if (sistemaBonus) {
        console.log(`✅ Usando SistemaBonus para processar bônus`);
        const resultado = await sistemaBonus.processarBonusCompra(remetenteCompra, valorCompra);

        if (!resultado) {
            console.log(`   ❌ Cliente não tem referência ou já atingiu limite de compras`);
            return false;
        }

        // Enviar notificação de bônus
        try {
            const nomeComprador = await obterNomeContato(remetenteCompra);
            const convidadorId = resultado.convidadorId;
            const bonusMB = resultado.bonusMB;
            const comprasRealizadas = resultado.comprasRealizadas;

            // Buscar saldo atualizado
            const saldoObj = sistemaBonus.buscarSaldo(convidadorId);
            const novoSaldo = saldoObj ? saldoObj.saldo : bonusMB;
            const novoSaldoFormatado = novoSaldo >= 1024 ? `${(novoSaldo/1024).toFixed(2)}GB` : `${novoSaldo}MB`;

            // Buscar referência para saber se é automática ou manual
            const formatos = [
                remetenteCompra,
                remetenteCompra.replace('@c.us', '@lid'),
                remetenteCompra.replace('@lid', '@c.us')
            ];
            let referencia = null;
            for (const formato of formatos) {
                if (sistemaBonus.referenciasClientes[formato]) {
                    referencia = sistemaBonus.referenciasClientes[formato];
                    break;
                }
            }

            const isAutomatico = referencia?.automatico;
            const tipoReferencia = isAutomatico ? 'adicionou ao grupo' : `usou seu código ${referencia?.codigo || ''}`;

            // CORRIGIDO: Remover @lid e @c.us das menções
            const convidadorLimpo = convidadorId.replace('@c.us', '').replace('@lid', '');
            const remetenteCompraLimpo = remetenteCompra.replace('@c.us', '').replace('@lid', '');

            // CORRIGIDO: Usar grupoId ou convidadorId como destino da mensagem
            const destinoMensagem = grupoId || convidadorId;

            await client.sendMessage(destinoMensagem,
                `🎉 *BÔNUS DE REFERÊNCIA CREDITADO!*\n\n` +
                `💎 @${convidadorLimpo}, recebeste *${bonusMB}MB* de bônus!\n\n` +
                `👤 *Referenciado:* @${remetenteCompraLimpo}\n` +
                `📢 *Motivo:* @${remetenteCompraLimpo} que você ${tipoReferencia} fez uma compra!\n` +
                `🛒 *Compra:* ${comprasRealizadas}ª de 5\n` +
                `💰 *Novo saldo:* ${novoSaldoFormatado}\n\n` +
                `${novoSaldo >= 1024 ? '🚀 *Já podes sacar!* Use: *.sacar*' : '⏳ *Continua a convidar amigos para ganhar mais bônus!*'}`, {
                mentions: [convidadorId, remetenteCompra]
            });

            console.log(`   ✅ Bônus creditado via SistemaBonus: ${bonusMB}MB (${comprasRealizadas}/5)`);
        } catch (error) {
            console.error('❌ Erro ao enviar notificação de bônus:', error);
        }

        return {
            convidador: resultado.convidadorId,
            bonusGanho: resultado.bonusMB,
            compraAtual: resultado.comprasRealizadas,
            totalCompras: 5,
            novoSaldo: sistemaBonus.buscarSaldo(resultado.convidadorId)?.saldo || 0
        };
    }

    // === FALLBACK: Sistema antigo (caso sistemaBonus não esteja disponível) ===
    console.log(`⚠️ SistemaBonus não disponível, usando sistema antigo`);

    // Verificar se cliente tem referência
    const referencia = referenciasClientes[remetenteCompra];
    if (!referencia) {
        console.log(`   ❌ Cliente não tem referência registrada`);
        return false;
    }

    // Verificar se ainda pode ganhar bônus (máximo 5 compras)
    if (referencia.comprasRealizadas >= 5) {
        console.log(`   ⚠️ Cliente já fez 5 compras, sem mais bônus`);
        return false;
    }

    // Atualizar contador de compras
    referencia.comprasRealizadas++;

    // Creditar bônus ao convidador
    const convidador = referencia.convidadoPor;
    if (!bonusSaldos[convidador]) {
        bonusSaldos[convidador] = {
            saldo: 0,
            detalhesReferencias: {},
            historicoSaques: [],
            totalReferencias: 0
        };
    }

    // Adicionar 200MB ao saldo
    const bonusAtual = 200;
    bonusSaldos[convidador].saldo += bonusAtual;

    // Atualizar detalhes da referência
    if (!bonusSaldos[convidador].detalhesReferencias[remetenteCompra]) {
        bonusSaldos[convidador].detalhesReferencias[remetenteCompra] = {
            compras: 0,
            bonusGanho: 0,
            codigo: referencia.codigo,
            ativo: true
        };
    }

    bonusSaldos[convidador].detalhesReferencias[remetenteCompra].compras = referencia.comprasRealizadas;
    bonusSaldos[convidador].detalhesReferencias[remetenteCompra].bonusGanho += bonusAtual;

    // Enviar notificação de bônus por referência
    try {
        const nomeComprador = await obterNomeContato(remetenteCompra);
        const nomeConvidador = await obterNomeContato(convidador);
        const novoSaldo = bonusSaldos[convidador].saldo;
        const novoSaldoFormatado = novoSaldo >= 1024 ? `${(novoSaldo/1024).toFixed(2)}GB` : `${novoSaldo}MB`;

        // Verificar se é referência automática ou manual
        const isAutomatico = referencia.automatico;
        const tipoReferencia = isAutomatico ? 'adicionou ao grupo' : `usou seu código ${referencia.codigo}`;

        // CORRIGIDO: Remover @lid e @c.us das menções
        const convidadorLimpo = convidador.replace('@c.us', '').replace('@lid', '');
        const remetenteCompraLimpo = remetenteCompra.replace('@c.us', '').replace('@lid', '');

        // CORRIGIDO: Usar grupoId ou convidador como destino da mensagem
        const destinoMensagem = grupoId || convidador;

        await client.sendMessage(destinoMensagem,
            `🎉 *BÔNUS DE REFERÊNCIA CREDITADO!*\n\n` +
            `💎 @${convidadorLimpo}, recebeste *${bonusAtual}MB* de bônus!\n\n` +
            `👤 *Referenciado:* @${remetenteCompraLimpo}\n` +
            `📢 *Motivo:* @${remetenteCompraLimpo} que você ${tipoReferencia} fez uma compra!\n` +
            `🛒 *Compra:* ${referencia.comprasRealizadas}ª de 5\n` +
            `💰 *Novo saldo:* ${novoSaldoFormatado}\n\n` +
            `${novoSaldo >= 1024 ? '🚀 *Já podes sacar!* Use: *.sacar*' : '⏳ *Continua a convidar amigos para ganhar mais bônus!*'}`, {
            mentions: [convidador, remetenteCompra]
        });
    } catch (error) {
        console.error('❌ Erro ao enviar notificação de bônus:', error);
    }

    // Salvar dados
    agendarSalvamento();
    
    console.log(`   ✅ Bônus creditado: ${bonusAtual}MB (${referencia.comprasRealizadas}/5)`);
    
    return {
        convidador: convidador,
        bonusGanho: bonusAtual,
        compraAtual: referencia.comprasRealizadas,
        totalCompras: 5,
        novoSaldo: bonusSaldos[convidador].saldo
    };
}

// === CRIAR REFERÊNCIA AUTOMÁTICA ===
async function criarReferenciaAutomatica(convidadorId, convidadoId, grupoId) {
    try {
        console.log(`🤝 Criando referência automática: ${convidadorId} → ${convidadoId}`);

        // Verificar se o convidado já tem referência
        if (referenciasClientes[convidadoId]) {
            console.log(`   ⚠️ Cliente ${convidadoId} já tem referência registrada`);
            return false;
        }

        // Verificar se o convidador não está tentando convidar a si mesmo
        if (convidadorId === convidadoId) {
            console.log(`   ❌ Convidador tentou convidar a si mesmo`);
            return false;
        }

        // Gerar código único para esta referência (para compatibilidade com sistema antigo)
        const codigo = gerarCodigoReferencia(convidadorId);

        // Registrar código de referência (ESTRUTURA PADRONIZADA)
        codigosReferencia[codigo] = {
            dono: convidadorId, // CORRIGIDO: usar 'dono' em vez de 'criador'
            nome: 'Auto', // Nome simplificado para referências automáticas
            criado: new Date().toISOString(),
            ativo: true,
            usado: true,
            usadoPor: convidadoId,
            dataUso: new Date().toISOString(),
            automatico: true // Marcar como referência automática
        };

        // Registrar referência do cliente
        referenciasClientes[convidadoId] = {
            codigo: codigo,
            convidadoPor: convidadorId,
            dataRegistro: new Date().toISOString(),
            comprasRealizadas: 0,
            automatico: true // Marcar como referência automática
        };

        // Inicializar saldo de bônus do convidador se não existir
        if (!bonusSaldos[convidadorId]) {
            bonusSaldos[convidadorId] = {
                saldo: 0,
                detalhesReferencias: {},
                historicoSaques: [],
                totalReferencias: 0
            };
        }

        // Incrementar total de referências
        bonusSaldos[convidadorId].totalReferencias++;

        // Inicializar detalhes da referência
        bonusSaldos[convidadorId].detalhesReferencias[convidadoId] = {
            compras: 0,
            bonusGanho: 0,
            codigo: codigo,
            ativo: true,
            automatico: true
        };

        // CORRIGIDO: Salvar dados (reativar salvamento para persistir referências)
        agendarSalvamento();

        // Obter nomes dos participantes para notificação
        const nomeConvidador = await obterNomeContato(convidadorId);
        const nomeConvidado = await obterNomeContato(convidadoId);

        // Enviar notificação no grupo
        try {
            // CORRIGIDO: Remover @lid e @c.us das menções
            const convidadorLimpo = convidadorId.replace('@c.us', '').replace('@lid', '');
            const convidadoLimpo = convidadoId.replace('@c.us', '').replace('@lid', '');

            await client.sendMessage(grupoId,
                `🎉 *NOVO MEMBRO ADICIONADO!*\n\n` +
                `👋 Bem-vindo @${convidadoLimpo}!\n\n` +
                `📢 Adicionado por: @${convidadorLimpo}\n` +
                `🎁 @${convidadorLimpo} ganhará *200MB* a cada compra de @${convidadoLimpo}!\n\n` +
                `📋 *Benefícios:*\n` +
                `• Máximo: 5 compras = 1000MB (1GB)\n` +
                `• Saque mínimo: 1000MB\n` +
                `• Sistema automático ativo!\n\n` +
                `💡 _Continue convidando amigos para ganhar mais bônus!_`, {
                mentions: [convidadorId, convidadoId]
            });

            console.log(`✅ Notificação de referência automática enviada`);
        } catch (error) {
            console.error('❌ Erro ao enviar notificação de referência:', error);
        }

        console.log(`✅ Referência automática criada: ${codigo} (${nomeConvidador} → ${nomeConvidado})`);

        return {
            codigo: codigo,
            convidador: convidadorId,
            convidado: convidadoId,
            automatico: true
        };

    } catch (error) {
        console.error('❌ Erro ao criar referência automática:', error);
        return false;
    }
}

// === OBTER NOME DO CONTATO ===
async function obterNomeContato(contactId) {
    try {
        const contact = await client.getContactById(contactId);
        return contact.name || contact.pushname || contactId.replace('@c.us', '');
    } catch (error) {
        console.error(`❌ Erro ao obter nome do contato ${contactId}:`, error);
        return contactId.replace('@c.us', '');
    }
}

// === FUNÇÃO PARA NORMALIZAR VALORES ===
function normalizarValor(valor) {
    if (typeof valor === 'number') return valor;
    if (typeof valor === 'string') {
        // Remover caracteres não numéricos exceto ponto e vírgula
        let valorLimpo = valor.replace(/[^\d.,]/g, '');

        // Converter vírgula para ponto se for separador decimal
        if (valorLimpo.includes(',') && !valorLimpo.includes('.')) {
            const partes = valorLimpo.split(',');
            if (partes.length === 2 && partes[1].length <= 2) {
                valorLimpo = partes[0] + '.' + partes[1];
            } else {
                valorLimpo = valorLimpo.replace(/,/g, '');
            }
        } else if (valorLimpo.includes(',')) {
            // Se tem tanto vírgula quanto ponto, remover vírgulas (separadores de milhares)
            valorLimpo = valorLimpo.replace(/,/g, '');
        }

        const numeroFinal = parseFloat(valorLimpo) || 0;
        console.log(`🔧 normalizarValor: "${valor}" → "${valorLimpo}" → ${numeroFinal}`);
        return numeroFinal;
    }
    return 0;
}

// === FUNÇÃO PARA CALCULAR VALOR DO PEDIDO ===
function calcularValorPedido(megas, precosGrupo) {
    const megasNum = parseInt(megas) || 0;
    if (precosGrupo && precosGrupo[megasNum]) {
        return precosGrupo[megasNum];
    }
    // Fallback: calcular valor baseado em preço por MB (assumindo ~12.5MT/GB)
    const valorPorMB = 12.5 / 1024; // ~0.012MT por MB
    return Math.round(megasNum * valorPorMB);
}

// === FUNÇÃO PARA VERIFICAR RATE LIMIT ===
async function aguardarRateLimit() {
    const agora = Date.now();

    // Limpar requisições antigas (mais de 1 minuto) - LIMITA TAMANHO DO ARRAY
    requisicoesUltimoMinuto = requisicoesUltimoMinuto.filter(timestamp => agora - timestamp < 60000);

    // IMPORTANTE: Limitar tamanho do array para evitar uso excessivo de memória
    if (requisicoesUltimoMinuto.length > 50) {
        requisicoesUltimoMinuto = requisicoesUltimoMinuto.slice(-30); // Manter apenas últimos 30
    }

    // Verificar se atingiu limite de requisições por minuto
    if (requisicoesUltimoMinuto.length >= MAX_REQUISICOES_POR_MINUTO) {
        const maisAntiga = requisicoesUltimoMinuto[0];
        const tempoEspera = 60000 - (agora - maisAntiga);
        if (tempoEspera > 0) {
            console.log(`⏳ RATE LIMIT: Aguardando ${Math.ceil(tempoEspera/1000)}s antes de continuar...`);
            await new Promise(resolve => setTimeout(resolve, tempoEspera));
        }
    }

    // Aguardar delay mínimo entre requisições
    const tempoDesdeUltima = agora - ultimaRequisicao;
    if (tempoDesdeUltima < DELAY_ENTRE_REQUISICOES) {
        const delayNecessario = DELAY_ENTRE_REQUISICOES - tempoDesdeUltima;
        await new Promise(resolve => setTimeout(resolve, delayNecessario));
    }

    // Registrar requisição
    ultimaRequisicao = Date.now();
    requisicoesUltimoMinuto.push(ultimaRequisicao);
}

// === FUNÇÃO PARA VERIFICAR PAGAMENTO (SÓ BUSCA, NÃO MARCA) ===
async function verificarPagamentoIndividual(referencia, valorEsperado) {
    try {
        // AGUARDAR RATE LIMIT ANTES DE FAZER REQUISIÇÃO
        await aguardarRateLimit();

        const valorNormalizado = normalizarValor(valorEsperado);

        console.log(`🔍 REVENDEDORES: Verificando pagamento ${referencia} - ${valorNormalizado}MT (original: ${valorEsperado})`);

        // Primeira tentativa: busca pelo valor exato (COM RETRY AUTOMÁTICO)
        let response = await axiosComRetry({
            method: 'post',
            url: API_PAGAMENTOS_CONFIG.scriptUrl,
            data: {
                action: "buscar_por_referencia",
                referencia: referencia,
                valor: valorNormalizado
            },
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            timeout: 60000 // 60 segundos
        }, 3); // 3 tentativas

        if (response.data && response.data.encontrado) {
            // Verificar se já foi processado
            if (response.data.ja_processado) {
                console.log(`⚠️ REVENDEDORES: Pagamento ${referencia} já foi processado anteriormente!`);
                return 'JA_PROCESSADO'; // Retornar status especial
            }

            console.log(`✅ REVENDEDORES: Pagamento encontrado e PENDENTE (valor exato)!`);
            erros429Consecutivos = 0; // Resetar contador de erros 429
            return true;
        }

        console.log(`❌ REVENDEDORES: Pagamento não encontrado`);
        erros429Consecutivos = 0; // Resetar contador de erros 429
        return false;

    } catch (error) {
        // Detectar erro 429 (Too Many Requests)
        if (error.response && error.response.status === 429) {
            erros429Consecutivos++;
            console.error(`🚨 REVENDEDORES: Rate limit atingido (429) - Erro ${erros429Consecutivos}/${MAX_ERROS_429}`);

            // Pausar progressivamente baseado no número de erros
            if (erros429Consecutivos >= MAX_ERROS_429) {
                const pausaEmergencia = 2 * 60 * 1000; // 2 minutos (reduzido de 5)
                console.error(`⏸️ REVENDEDORES: Pausando verificações por ${pausaEmergencia/1000}s devido a múltiplos erros 429`);
                await new Promise(resolve => setTimeout(resolve, pausaEmergencia));
                erros429Consecutivos = 0; // Resetar após pausa
            } else {
                // Pausa menor para primeiro ou segundo erro
                const pausaCurta = 10000; // 10 segundos
                await new Promise(resolve => setTimeout(resolve, pausaCurta));
            }
            return false;
        }

        const ehTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        if (ehTimeout) {
            console.error(`⏰ REVENDEDORES: Timeout ao verificar pagamento ${referencia} - planilha demorou muito para responder`);
            console.error(`💡 Sugestão: O pagamento será verificado automaticamente no próximo ciclo de retry`);
        } else {
            console.error(`❌ REVENDEDORES: Erro ao verificar pagamento:`, error.message);
        }
        return false;
    }
}

// === FUNÇÃO PARA MARCAR PAGAMENTO COMO PROCESSADO ===
async function marcarPagamentoComoProcessado(referencia, valor) {
    try {
        // AGUARDAR RATE LIMIT ANTES DE FAZER REQUISIÇÃO
        await aguardarRateLimit();

        const valorNormalizado = normalizarValor(valor);

        console.log(`✅ REVENDEDORES: Marcando pagamento ${referencia} como PROCESSADO`);

        const response = await axiosComRetry({
            method: 'post',
            url: API_PAGAMENTOS_CONFIG.scriptUrl,
            data: {
                action: "marcar_processado",
                referencia: referencia,
                valor: valorNormalizado
            },
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            timeout: 60000 // 60 segundos
        }, 3); // 3 tentativas

        if (response.data && response.data.success) {
            console.log(`✅ REVENDEDORES: Pagamento ${referencia} marcado como PROCESSADO com sucesso!`);
            return true;
        } else {
            console.log(`⚠️ REVENDEDORES: Não foi possível marcar pagamento como processado: ${response.data?.message || 'Erro desconhecido'}`);
            return false;
        }

    } catch (error) {
        console.error(`❌ REVENDEDORES: Erro ao marcar pagamento como processado:`, error.message);
        return false;
    }
}

// Base de dados de compradores
let historicoCompradores = {};
const ARQUIVO_HISTORICO = 'historico_compradores.json';

// Cache de administradores REMOVIDO - usa apenas ADMINISTRADORES_GLOBAIS

// === FUNÇÕES DO SISTEMA DE RETRY SILENCIOSO ===

// Carregar pagamentos pendentes do arquivo
async function carregarPagamentosPendentes() {
    try {
        const dados = await fs.readFile(ARQUIVO_PAGAMENTOS_PENDENTES, 'utf8');
        pagamentosPendentes = JSON.parse(dados);
        console.log(`💾 RETRY: ${Object.keys(pagamentosPendentes).length} pagamentos pendentes carregados`);
    } catch (error) {
        console.log(`💾 RETRY: Nenhum arquivo de pendências encontrado - iniciando limpo`);
        pagamentosPendentes = {};
    }
}

// Salvar pagamentos pendentes no arquivo (com debounce)
async function salvarPagamentosPendentes() {
    // Limpar timeout anterior
    if (timeoutSalvamentoPagamentos) {
        clearTimeout(timeoutSalvamentoPagamentos);
    }

    // Aguardar 2 segundos antes de salvar (agrupar múltiplas mudanças)
    timeoutSalvamentoPagamentos = setTimeout(async () => {
        try {
            await fs.writeFile(ARQUIVO_PAGAMENTOS_PENDENTES, JSON.stringify(pagamentosPendentes, null, 2));
            console.log(`💾 RETRY: Pagamentos pendentes salvos - ${Object.keys(pagamentosPendentes).length} pendências`);
        } catch (error) {
            console.error(`❌ RETRY: Erro ao salvar pendências:`, error);
        }
    }, 2000);
}

// Forçar salvamento imediato (para casos críticos)
async function salvarPagamentosPendentesImediato() {
    if (timeoutSalvamentoPagamentos) {
        clearTimeout(timeoutSalvamentoPagamentos);
    }
    try {
        await fs.writeFile(ARQUIVO_PAGAMENTOS_PENDENTES, JSON.stringify(pagamentosPendentes, null, 2));
        console.log(`💾 RETRY: Salvamento imediato - ${Object.keys(pagamentosPendentes).length} pendências`);
    } catch (error) {
        console.error(`❌ RETRY: Erro ao salvar pendências:`, error);
    }
}

// Adicionar pagamento para retry
async function adicionarPagamentoPendente(referencia, valorComprovante, dadosCompletos, message, resultadoIA) {
    const id = `${referencia}_${Date.now()}`;
    const agora = Date.now();

    const pendencia = {
        id: id,
        referencia: referencia,
        valorComprovante: valorComprovante,
        dadosCompletos: dadosCompletos,
        timestamp: agora,
        expira: agora + RETRY_TIMEOUT,
        tentativas: 0,
        // Dados para resposta
        chatId: message.from,
        messageData: {
            author: message.author || message.from,
            notifyName: message._data?.notifyName || 'N/A'
        },
        resultadoIA: resultadoIA
    };

    pagamentosPendentes[id] = pendencia;
    await salvarPagamentosPendentes();

    console.log(`⏳ RETRY: Pagamento ${referencia} adicionado à fila de retry`);

    // Iniciar timer se não existe
    if (!timerRetryPagamentos) {
        iniciarTimerRetryPagamentos();
    }

    return id;
}

// Remover pagamento pendente
async function removerPagamentoPendente(id) {
    if (pagamentosPendentes[id]) {
        delete pagamentosPendentes[id];
        await salvarPagamentosPendentes();
        console.log(`✅ RETRY: Pagamento ${id} removido da fila`);
    }
}

// Iniciar timer de verificação periódica
function iniciarTimerRetryPagamentos() {
    if (timerRetryPagamentos) {
        clearInterval(timerRetryPagamentos);
    }

    console.log(`🔄 RETRY: Iniciando verificação a cada ${RETRY_INTERVAL/1000}s`);

    timerRetryPagamentos = setInterval(async () => {
        await verificarPagamentosPendentes();
    }, RETRY_INTERVAL);
}

// Parar timer de verificação
function pararTimerRetryPagamentos() {
    if (timerRetryPagamentos) {
        clearInterval(timerRetryPagamentos);
        timerRetryPagamentos = null;
        console.log(`⏹️ RETRY: Timer de verificação parado`);
    }
}

// Verificar todos os pagamentos pendentes
async function verificarPagamentosPendentes() {
    const agora = Date.now();
    const pendencias = Object.values(pagamentosPendentes);

    if (pendencias.length === 0) {
        pararTimerRetryPagamentos();
        return;
    }

    console.log(`🔍 RETRY: Verificando ${pendencias.length} pagamentos pendentes...`);
    console.log(`⏱️ RATE LIMIT: Verificações com delay de ${DELAY_ENTRE_REQUISICOES/1000}s entre cada uma`);

    // PROCESSAR MAIS PAGAMENTOS POR VEZ (10 em vez de 5)
    const LOTE_MAXIMO = 10;
    let processados = 0;

    for (const pendencia of pendencias) {
        // Parar se já processou o lote máximo
        if (processados >= LOTE_MAXIMO) {
            console.log(`⏸️ RETRY: Processados ${processados} pagamentos neste ciclo. Restantes serão verificados no próximo.`);
            break;
        }

        // Verificar se expirou (5 minutos)
        if (agora > pendencia.expira) {
            const tempoDecorrido = Math.floor((agora - pendencia.timestamp) / 1000 / 60);
            console.log(`⏰ RETRY: Pagamento ${pendencia.referencia} expirou após ${tempoDecorrido}min sem confirmação`);

            // NOTIFICAR USUÁRIO SOBRE FALHA - DESABILITADO
            // await notificarPagamentoExpirado(pendencia);
            await removerPagamentoPendente(pendencia.id);
            continue;
        }

        // Verificar se atingiu limite de tentativas
        if (pendencia.tentativas >= MAX_RETRY_ATTEMPTS) {
            console.log(`❌ RETRY: Pagamento ${pendencia.referencia} atingiu limite de ${MAX_RETRY_ATTEMPTS} tentativas`);

            // NOTIFICAR USUÁRIO SOBRE FALHA - DESABILITADO
            // await notificarPagamentoExpirado(pendencia);
            await removerPagamentoPendente(pendencia.id);
            continue;
        }

        // Verificar pagamento (COM RATE LIMIT AUTOMÁTICO)
        pendencia.tentativas++;
        console.log(`🔍 RETRY: Tentativa ${pendencia.tentativas}/${MAX_RETRY_ATTEMPTS} para ${pendencia.referencia}`);

        const pagamentoConfirmado = await verificarPagamentoIndividual(pendencia.referencia, pendencia.valorComprovante);

        // Verificar se pagamento já foi processado anteriormente
        if (pagamentoConfirmado === 'JA_PROCESSADO') {
            console.log(`⚠️ RETRY: Pagamento ${pendencia.referencia} já foi processado - removendo da fila silenciosamente`);
            await removerPagamentoPendente(pendencia.id);
        } else if (pagamentoConfirmado) {
            console.log(`✅ RETRY: Pagamento ${pendencia.referencia} confirmado! Processando...`);
            await processarPagamentoConfirmado(pendencia);
            await removerPagamentoPendente(pendencia.id);
        }

        processados++;
    }

    // Salvar progresso apenas UMA VEZ ao final (em vez de a cada verificação)
    if (processados > 0) {
        await salvarPagamentosPendentes();
    }

    // Se não há mais pendências, parar timer
    if (Object.keys(pagamentosPendentes).length === 0) {
        pararTimerRetryPagamentos();
    }
}

// Notificar usuário quando pagamento expirar sem confirmação
async function notificarPagamentoExpirado(pendencia) {
    try {
        const { chatId, referencia, valorComprovante, tentativas } = pendencia;
        const tempoDecorrido = Math.floor((Date.now() - pendencia.timestamp) / 1000 / 60);

        console.log(`📢 RETRY: Notificando usuário sobre pagamento expirado ${referencia}`);

        await client.sendMessage(chatId,
            `❌ *NÃO FOI POSSÍVEL CONFIRMAR O PAGAMENTO*\n\n` +
            `💳 Referência: ${referencia}\n` +
            `💰 Valor: ${valorComprovante}MT\n` +
            `🔄 Tentativas: ${tentativas}\n` +
            `⏰ Tempo: ${tempoDecorrido} minutos\n\n` +
            `⚠️ *Possíveis causas:*\n` +
            `• A mensagem de confirmação ainda não foi recebida pelo sistema\n` +
            `• Referência incorreta no comprovante\n` +
            `• Valor diferente do esperado\n\n` +
            `💡 *O que fazer:*\n` +
            `1. Aguarde mais alguns minutos e envie o comprovante novamente\n` +
            `2. Verifique se a referência está correta\n` +
            `3. Entre em contato com o suporte se o problema persistir\n\n` +
            `🕐 ${new Date().toLocaleString('pt-BR')}`
        );

    } catch (error) {
        console.error(`❌ RETRY: Erro ao notificar pagamento expirado:`, error.message);
    }
}

// Processar pagamento confirmado após retry
async function processarPagamentoConfirmado(pendencia) {
    try {
        const { dadosCompletos, chatId, messageData, resultadoIA } = pendencia;
        const [referencia, megas, numero] = dadosCompletos.split('|');

        // === VERIFICAÇÃO DE VALOR MUITO BAIXO ===
        if (megas === 'VALOR_MUITO_BAIXO') {
            console.log(`❌ VALOR MUITO BAIXO no pagamento confirmado: ${referencia}`);

            const configGrupo = getConfiguracaoGrupo(chatId);
            const precos = ia.extrairPrecosTabela(configGrupo.tabela);
            const menorPreco = Math.min(...precos.map(p => p.preco));

            await client.sendMessage(chatId,
                `❌ *Valor muito baixo*\n\n` +
                `💳 O valor transferido está abaixo do pacote mínimo disponível.\n\n` +
                `📋 *Pacote mais barato:* ${menorPreco}MT\n\n` +
                `💡 *Para ver todos os pacotes:* digite "tabela"`
            );
            return;
        }

        // Enviar mensagem de confirmação
        await client.sendMessage(chatId,
            `✅ *PAGAMENTO CONFIRMADO!*\n\n` +
            `💰 Referência: ${referencia}\n` +
            `📊 Megas: ${megas} MB\n` +
            `📱 Número: ${numero}\n` +
            `💳 Valor: ${pendencia.valorComprovante}MT\n\n` +
            `🎉 Pedido está sendo processado!\n` +
            `⏰ ${new Date().toLocaleString('pt-BR')}`
        );

        // Processar bônus de referência
        const bonusInfo = await processarBonusCompra(chatId, megas, chatId);

        // Enviar para Tasker/Planilha
        const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, chatId, messageData.author, pendencia.valorComprovante);

        // Verificar duplicatas
        if (resultadoEnvio && resultadoEnvio.duplicado) {
            await client.sendMessage(chatId,
                `⚠️ *AVISO: PEDIDO DUPLICADO*\n\n` +
                `Este pedido ${resultadoEnvio.status_existente === 'PROCESSADO' ? 'já foi processado' : 'está na fila'}.\n` +
                `Status: ${resultadoEnvio.status_existente}`
            );
            return;
        }

        // === MARCAR PAGAMENTO COMO PROCESSADO APÓS ENVIO BEM-SUCEDIDO ===
        if (resultadoEnvio && resultadoEnvio.sucesso) {
            await marcarPagamentoComoProcessado(referencia, pendencia.valorComprovante);
        }

        // Registrar comprador
        await registrarComprador(chatId, numero, messageData.notifyName, megas);

        // REMOVIDO: Encaminhamento de mensagens (sistema movido para outro bot)

        console.log(`✅ RETRY: Pagamento ${pendencia.referencia} processado com sucesso`);

    } catch (error) {
        console.error(`❌ RETRY: Erro ao processar pagamento confirmado:`, error);
    }
}

// Cache para evitar logs repetidos de grupos
let gruposLogados = new Set();

// === COMANDOS CUSTOMIZADOS ===
let comandosCustomizados = {};
const ARQUIVO_COMANDOS = 'comandos_customizados.json';

// REMOVIDO: Sistema de registro de mensagens (movido para outro bot)

// REMOVIDO: Função registrarPrimeiraMensagem (sistema movido para outro bot)

// Configuração de administradores GLOBAIS
const ADMINISTRADORES_GLOBAIS = [
    '258874100607@c.us',
    '258871112049@c.us',
    '258845356399@c.us',
    '258840326152@c.us',
    '258852118624@c.us',
    '251032533737504@lid', // @lid do Mr Durst
    '251032533737504@lid',
    '203109674577958@c.us',
    '203109674577958@lid',
    '23450974470333@lid',   // ID interno do WhatsApp para 852118624
    // Novos administradores adicionados:
    '258850401416@c.us',    // +258 85 040 1416 - Kelven Junior
    '216054655656152@lid',  // @lid do Kelven Junior
    '258858891101@c.us',    // +258 85 889 1101 - Isaac
    '85307059867830@lid',   // @lid do Isaac
    '258865627840@c.us',    // +258 86 562 7840 - Ercílio
    '170725386272876@lid',  // @lid do Ercílio
    '258857013922@c.us',    // +258 85 701 3922 - Frederico
    '29945149558840@lid',   // @lid do Frederico
    '258879833297@c.us',    // +258 87 983 3297 - Astro Tech
    '278438854287537@lid',  // @lid do Astro Tech
    '258844093189@c.us',    // +258 84 409 3189 - Leonel
    '67611928871020@lid',   // @lid do Leonel
    '258871784594@c.us',    // +258 87 178 4594 - Shop NET
    '49603198071035@lid',   // @lid do Shop NET
    '258879914172@c.us',    // +258 87 991 4172 - walter
    '40811249045561@lid',   // @lid do walter
    '258844345161@c.us',    // +258 84 434 5161 - Mozstream's
    '144478891450544@lid',  // @lid do Mozstream's
    '258849430041@c.us',    // +258 84 943 0041 - Junior Zucula
    '216329281892468@lid',  // @lid do Junior Zucula
    '258842577015@c.us',    // +258 84 257 7015 - Ercílio (2º número)
    '113267548680269@lid',  // @lid do Ercílio (2º número)
    '258876264874@c.us',    // +258 87 626 4874 - Alln
    '92522890170444@lid'    // @lid do Alln
];

// Mapeamento de IDs internos (@lid) para números reais (@c.us) - SISTEMA DINÂMICO
let MAPEAMENTO_IDS = {
    '23450974470333@lid': '258852118624@c.us',  // Seu ID
    '245075749638206@lid': null,  // Será identificado automaticamente
    '76991768342659@lid': '258870818180@c.us',  // Joãozinho - corrigido manualmente
    '216054655656152@lid': '258850401416@c.us', // Kelven Junior
    '85307059867830@lid': '258858891101@c.us',  // Isaac
    '170725386272876@lid': '258865627840@c.us',  // Ercílio
    '251032533737504@lid': '258874100607@c.us', // Mr Durst
    '67611928871020@lid': '258844093189@c.us',   // Leonel
    '278438854287537@lid': '258879833297@c.us',  // Astro Tech
    '29945149558840@lid': '258857013922@c.us',   // Frederico
    '49603198071035@lid': '258871784594@c.us',   // Shop NET
    '40811249045561@lid': '258879914172@c.us',   // walter
    '144478891450544@lid': '258844345161@c.us',  // Mozstream's
    '216329281892468@lid': '258849430041@c.us',  // Junior Zucula
    '113267548680269@lid': '258842577015@c.us',  // Ercílio (2º número)
    '92522890170444@lid': '258876264874@c.us'    // Alln
};

// === SISTEMA AUTOMÁTICO DE MAPEAMENTO LID ===
const ARQUIVO_MAPEAMENTOS = path.join(__dirname, 'mapeamentos_lid.json');

async function carregarMapeamentos() {
    try {
        // Tentar ler o arquivo diretamente (se não existir, vai dar erro e cai no catch)
        const data = await fs.readFile(ARQUIVO_MAPEAMENTOS, 'utf8');
        const mapeamentosSalvos = JSON.parse(data);
        // Mesclar com os mapeamentos base
        MAPEAMENTO_IDS = { ...MAPEAMENTO_IDS, ...mapeamentosSalvos };
        console.log(`✅ Carregados ${Object.keys(mapeamentosSalvos).length} mapeamentos LID salvos`);
    } catch (error) {
        // Se o arquivo não existir (ENOENT), apenas ignora silenciosamente
        if (error.code === 'ENOENT') {
            console.log('📋 Nenhum arquivo de mapeamentos LID encontrado - usando mapeamentos padrão');
        } else {
            console.error('❌ Erro ao carregar mapeamentos LID:', error.message);
        }
    }
}

async function salvarMapeamentos() {
    try {
        // Filtrar apenas os mapeamentos válidos (não null)
        const mapeamentosValidos = {};
        for (const [lid, numero] of Object.entries(MAPEAMENTO_IDS)) {
            if (numero && numero !== null) {
                mapeamentosValidos[lid] = numero;
            }
        }
        await fs.writeFile(ARQUIVO_MAPEAMENTOS, JSON.stringify(mapeamentosValidos, null, 2));
        console.log(`💾 Salvos ${Object.keys(mapeamentosValidos).length} mapeamentos LID`);
    } catch (error) {
        console.error('❌ Erro ao salvar mapeamentos LID:', error.message);
    }
}

async function adicionarMapeamento(lid, numeroReal) {
    if (!lid || !numeroReal || lid === numeroReal) return false;

    // Validar formato
    if (!lid.endsWith('@lid') || !numeroReal.endsWith('@c.us')) return false;

    // Verificar se já existe
    if (MAPEAMENTO_IDS[lid] === numeroReal) return false;

    // Adicionar novo mapeamento
    MAPEAMENTO_IDS[lid] = numeroReal;
    console.log(`✅ NOVO MAPEAMENTO: ${lid} → ${numeroReal}`);
    await salvarMapeamentos();
    return true;
}

// Função para tentar aprender mapeamento automaticamente quando ambos os formatos estão disponíveis
async function aprenderMapeamento(message) {
    try {
        if (!message.from || !message.author) return;

        const from = message.from; // ID do remetente (pode ser @c.us)
        const author = message.author; // ID do autor (pode ser @lid)

        // Se temos um @lid e um @c.us, podemos aprender o mapeamento
        if (author && author.endsWith('@lid') && from && from.endsWith('@c.us')) {
            // Extrair número base para validar se correspondem
            const numeroLid = author.replace('@lid', '');
            const numeroReal = from.replace('@c.us', '');

            // Tentar encontrar uma correspondência lógica (primeiros dígitos, etc.)
            // Por enquanto, sempre tentar mapear se não temos o mapeamento
            if (!MAPEAMENTO_IDS[author]) {
                await adicionarMapeamento(author, from);
                console.log(`🔍 APRENDIZADO: Detectado possível mapeamento ${author} → ${from}`);
            }
        }
    } catch (error) {
        // Silencioso - não queremos spam nos logs
    }
}

// === CONFIGURAÇÃO DE MODERAÇÃO ===
const MODERACAO_CONFIG = {
    ativado: {
        '258820749141-1441573529@g.us': true,
        '120363152151047451@g.us': true,
        '258840161370-1471468657@g.us': true
    },
    detectarLinks: true,
    apagarMensagem: true,
    removerUsuario: true, // DESATIVADO: não remove mais usuários, apenas apaga a mensagem
    excecoes: [
        '258861645968@c.us',
        '258871112049@c.us',
        '258852118624@c.us'
    ],
    // Configuração Anti-Spam
    antiSpam: {
        ativado: true,
        maxMensagensIguais: 5, // Máximo de mensagens iguais permitidas
        intervaloSegundos: 60, // Janela de tempo em segundos
        removerUsuario: false, // Desativado - apenas apaga mensagens
        apagarMensagens: true
    }
};

// === CACHE ANTI-SPAM ===
// Estrutura: { 'groupId': { 'userId': { 'mensagemHash': [{ timestamp, messageId }] } } }
const antiSpamCache = new Map();

// Função para limpar cache antigo (mensagens fora da janela de tempo)
function limparCacheAntiSpam() {
    const agora = Date.now();
    const intervaloMs = MODERACAO_CONFIG.antiSpam.intervaloSegundos * 1000;

    for (const [groupId, usuarios] of antiSpamCache.entries()) {
        for (const [userId, mensagens] of usuarios.entries()) {
            for (const [hash, lista] of mensagens.entries()) {
                const listaFiltrada = lista.filter(item => (agora - item.timestamp) < intervaloMs);
                if (listaFiltrada.length === 0) {
                    mensagens.delete(hash);
                } else {
                    mensagens.set(hash, listaFiltrada);
                }
            }
            if (mensagens.size === 0) {
                usuarios.delete(userId);
            }
        }
        if (usuarios.size === 0) {
            antiSpamCache.delete(groupId);
        }
    }
}

// Limpar cache a cada 30 segundos
setInterval(limparCacheAntiSpam, 30000);

// Função para verificar e registrar spam
async function verificarAntiSpam(message, client) {
    if (!MODERACAO_CONFIG.antiSpam.ativado) return false;

    const chatId = message.from;
    const authorId = message.author || message.from;
    const conteudo = message.body.trim().toLowerCase();

    // Ignorar mensagens vazias
    if (!conteudo) return false;

    // Verificar se é grupo monitorado
    const ativadoExplicit = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId) ||
        (MODERACAO_CONFIG.ativado && MODERACAO_CONFIG.ativado[chatId]);

    if (!ativadoExplicit) return false;

    // Ignorar exceções e admins
    if (MODERACAO_CONFIG.excecoes.includes(authorId) || isAdministrador(authorId)) {
        return false;
    }

    // Criar hash simples da mensagem
    const mensagemHash = conteudo;
    const agora = Date.now();
    const intervaloMs = MODERACAO_CONFIG.antiSpam.intervaloSegundos * 1000;

    // Inicializar estruturas se não existirem
    if (!antiSpamCache.has(chatId)) {
        antiSpamCache.set(chatId, new Map());
    }
    const grupoCache = antiSpamCache.get(chatId);

    if (!grupoCache.has(authorId)) {
        grupoCache.set(authorId, new Map());
    }
    const usuarioCache = grupoCache.get(authorId);

    if (!usuarioCache.has(mensagemHash)) {
        usuarioCache.set(mensagemHash, []);
    }
    const listaMensagens = usuarioCache.get(mensagemHash);

    // Adicionar mensagem atual
    listaMensagens.push({
        timestamp: agora,
        messageId: message.id._serialized,
        message: message
    });

    // Filtrar apenas mensagens dentro da janela de tempo
    const mensagensRecentes = listaMensagens.filter(item => (agora - item.timestamp) < intervaloMs);
    usuarioCache.set(mensagemHash, mensagensRecentes);

    // Verificar se atingiu o limite de spam
    if (mensagensRecentes.length >= MODERACAO_CONFIG.antiSpam.maxMensagensIguais) {
        console.log(`🚨 SPAM DETECTADO: ${authorId} enviou ${mensagensRecentes.length} mensagens iguais em ${MODERACAO_CONFIG.antiSpam.intervaloSegundos}s`);

        // Apagar todas as mensagens de spam
        if (MODERACAO_CONFIG.antiSpam.apagarMensagens) {
            for (const item of mensagensRecentes) {
                try {
                    if (item.message && typeof item.message.delete === 'function') {
                        await item.message.delete(true);
                        console.log(`🗑️ Mensagem de spam deletada`);
                    }
                } catch (err) {
                    console.error('❌ Erro ao deletar mensagem de spam:', err.message);
                }
            }
        }

        // Remover usuário
        if (MODERACAO_CONFIG.antiSpam.removerUsuario) {
            let mentionId = String(authorId).replace('@c.us', '').replace('@lid', '');
            let nomeExibicao = mentionId;

            try {
                const contato = await client.getContactById(authorId);
                if (contato) {
                    nomeExibicao = contato.pushname || contato.name || contato.number || mentionId;
                }
            } catch (err) {
                // ignora erro
            }

            // Enviar aviso
            try {
                const ehIDValido = authorId &&
                    typeof authorId === 'string' &&
                    (authorId.includes('@c.us') || authorId.includes('@lid')) &&
                    !authorId.startsWith('SAQUE_BONUS_') &&
                    !authorId.startsWith('SAQ');

                const aviso = `🚫 @${mentionId} foi removido(a) do grupo por SPAM (${mensagensRecentes.length} mensagens iguais em menos de 1 minuto).`;

                if (ehIDValido) {
                    await client.sendMessage(chatId, aviso, { mentions: [authorId] });
                } else {
                    await client.sendMessage(chatId, aviso);
                }
            } catch (errAviso) {
                console.log('⚠️ Não foi possível enviar aviso de spam:', errAviso.message);
            }

            // Remover participante
            await removerParticipante(chatId, authorId, `SPAM: ${mensagensRecentes.length} mensagens iguais`);
        }

        // Limpar cache do usuário após ação
        usuarioCache.delete(mensagemHash);

        return true; // Spam detectado e tratado
    }

    return false; // Não é spam
}

// Configuração para cada grupo
const CONFIGURACAO_GRUPOS = {
    '258840161370-1471468657@g.us': {
        nome: 'Venda Automática 24/7',
        tabela: `📢🔥 TABELA ATUALIZADA – OUTUBRO 2025 🔥📢
Internet e Chamadas Ilimitadas – Vodacom
Pacotes Diários | Semanais | Mensais

OFERTA ESPECIAL – 24 HORAS ⏱
600MB - 10MT
800MB - 15MT
1024MB - 17MT
1200MB - 20MT
2048MB - 34MT

PACOTES DIÁRIOS (24H ⏱)
2400MB - 40MT
3072MB - 51MT
4096MB - 68MT
5120MB - 85MT
6144MB - 102MT
7168MB - 119MT
8192MB - 136MT
9144MB - 153MT
10240MB - 170MT

PACOTES PREMIUM (3 DIAS 🗓 – RENOVÁVEIS)
2000MB - 44MT
3000MB - 66MT
4000MB - 88MT
5000MB - 109MT
6000MB - 133MT
7000MB - 149MT
10000MB - 219MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 3 dias

SEMANAIS BÁSICOS (5 DIAS 🗓 – RENOVÁVEIS)
1700MB - 45MT
2900MB - 80MT
3400MB - 110MT
5500MB - 150MT
7800MB - 200MT
11400MB - 300MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 5 dias

SEMANAIS PREMIUM (15 DIAS 🗓 – RENOVÁVEIS)
3000MB - 100MT
5000MB - 149MT
8000MB - 201MT
10000MB - 231MT
20000MB - 352MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 15 dias

PACOTES MENSAIS EXCLUSIVOS (30 DIAS 📆 – NÃO RENOVÁVEIS)
2.8GB - 100MT
5.8GB - 175MT
8.8GB - 200MT
10.8GB - 249MT
12.8GB - 300MT
15.8GB - 349MT
18.8GB - 400MT
20.8GB - 449MT
25.8GB - 549MT
32.8GB - 649MT
51.2GB - 1049MT
60.2GB - 1249MT
80.2GB - 1449MT
100.2GB - 1700MT
Observação: Pacotes mensais não compatíveis com Txuna

CHAMADAS ILIMITADAS — VODACOM 📞 ♾

11GB - 449MT - Ilimitadas ✨
14.5GB - 500MT - Ilimitadas
26.5GB - 700MT - Ilimitadas
37.5GB - 1000MT - Ilimitadas
53.5GB - 1500MT - Ilimitadas
102.5GB - 2150MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

CHAMADAS ILIMITADAS — MOVITEL 📞 ♾

9GB - 469MT - Ilimitadas ✨
23GB - 950MT - Ilimitadas
38GB - 1450MT - Ilimitadas
46GB - 1700MT - Ilimitadas
53GB - 1900MT - Ilimitadas
68GB - 2400MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

🔹 CONEXÃO SEM LIMITES 🔹
Internet rápida, chamadas e SMS ilimitadas.
Pacotes exclusivos Vodacom e Movitel.
Sempre conectado, sempre no controle!
`,

        pagamento: `💸 FORMAS DE PAGAMENTO

🟠 E-Mola – Glória | 📲 860186270  
🔴 M-Pesa – Leonor | 📲 857451196  

⚠ ATENÇÃO  
▪ Após o pagamento, envie a confirmação ✉ ** e o seu número para receber o seu pacote 📲  
▪ Envie ** o valor exato da tabela 💰  

NB: Válido apenas para Vodacom  
🚀 Garanta seus Megabytes agora!
`
    },
'258876291014-1634575097@g.us': {
        nome: '🪐V2 Megabytes NetConnect 🌍',
        tabela: `📢🔥 TABELA ATUALIZADA – OUTUBRO 2025 🔥📢
Internet e Chamadas Ilimitadas – Vodacom
Pacotes Diários | Semanais | Mensais

OFERTA ESPECIAL – 24 HORAS ⏱
600MB - 10MT
800MB - 15MT
1024MB - 17MT
1200MB - 20MT
2048MB - 34MT

PACOTES DIÁRIOS (24H ⏱)
2400MB - 40MT
3072MB - 51MT
4096MB - 68MT
5120MB - 85MT
6144MB - 102MT
7168MB - 119MT
8192MB - 136MT
9144MB - 153MT
10240MB - 170MT

PACOTES PREMIUM (3 DIAS 🗓 – RENOVÁVEIS)
2000MB - 44MT
3000MB - 66MT
4000MB - 88MT
5000MB - 109MT
6000MB - 133MT
7000MB - 149MT
10000MB - 219MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 3 dias

SEMANAIS BÁSICOS (5 DIAS 🗓 – RENOVÁVEIS)
1700MB - 45MT
2900MB - 80MT
3400MB - 110MT
5500MB - 150MT
7800MB - 200MT
11400MB - 300MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 5 dias

SEMANAIS PREMIUM (15 DIAS 🗓 – RENOVÁVEIS)
3000MB - 100MT
5000MB - 149MT
8000MB - 201MT
10000MB - 231MT
20000MB - 352MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 15 dias

PACOTES MENSAIS EXCLUSIVOS (30 DIAS 📆 – NÃO RENOVÁVEIS)
2.8GB - 100MT
5.8GB - 175MT
8.8GB - 200MT
10.8GB - 249MT
12.8GB - 300MT
15.8GB - 349MT
18.8GB - 400MT
20.8GB - 449MT
25.8GB - 549MT
32.8GB - 649MT
51.2GB - 1049MT
60.2GB - 1249MT
80.2GB - 1449MT
100.2GB - 1700MT
Observação: Pacotes mensais não compatíveis com Txuna

CHAMADAS ILIMITADAS — VODACOM 📞 ♾

11GB - 449MT - Ilimitadas ✨
14.5GB - 500MT - Ilimitadas
26.5GB - 700MT - Ilimitadas
37.5GB - 1000MT - Ilimitadas
53.5GB - 1500MT - Ilimitadas
102.5GB - 2150MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

CHAMADAS ILIMITADAS — MOVITEL 📞 ♾

9GB - 469MT - Ilimitadas ✨
23GB - 950MT - Ilimitadas
38GB - 1450MT - Ilimitadas
46GB - 1700MT - Ilimitadas
53GB - 1900MT - Ilimitadas
68GB - 2400MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

🔹 CONEXÃO SEM LIMITES 🔹
Internet rápida, chamadas e SMS ilimitadas.
Pacotes exclusivos Vodacom e Movitel.
Sempre conectado, sempre no controle!
`,

        pagamento: `💸 FORMAS DE PAGAMENTO

🟠 E-Mola – Glória | 📲 860186270  
🔴 M-Pesa – Leonor | 📲 857451196  

⚠ ATENÇÃO  
▪ Após o pagamento, envie a confirmação ✉ ** e o seu número para receber o seu pacote 📲  
▪ Envie ** o valor exato da tabela 💰  

NB: Válido apenas para Vodacom  
🚀 Garanta seus Megabytes agora!
`
    },
'120363419414311700@g.us': {
        nome: '🪐Megabytes PROMO',
        tabela: `📢🔥 TABELA ATUALIZADA – OUTUBRO 2025 🔥📢
Internet e Chamadas Ilimitadas – Vodacom
Pacotes Diários | Semanais | Mensais

OFERTA ESPECIAL – 24 HORAS ⏱
600MB - 10MT
800MB - 15MT
1024MB - 17MT
1200MB - 20MT
2048MB - 34MT

PACOTES DIÁRIOS (24H ⏱)
2400MB - 40MT
3072MB - 51MT
4096MB - 68MT
5120MB - 85MT
6144MB - 102MT
7168MB - 119MT
8192MB - 136MT
9144MB - 153MT
10240MB - 170MT

PACOTES PREMIUM (3 DIAS 🗓 – RENOVÁVEIS)
2000MB - 44MT
3000MB - 66MT
4000MB - 88MT
5000MB - 109MT
6000MB - 133MT
7000MB - 149MT
10000MB - 219MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 3 dias

SEMANAIS BÁSICOS (5 DIAS 🗓 – RENOVÁVEIS)
1700MB - 45MT
2900MB - 80MT
3400MB - 110MT
5500MB - 150MT
7800MB - 200MT
11400MB - 300MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 5 dias

SEMANAIS PREMIUM (15 DIAS 🗓 – RENOVÁVEIS)
3000MB - 100MT
5000MB - 149MT
8000MB - 201MT
10000MB - 231MT
20000MB - 352MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 15 dias

PACOTES MENSAIS EXCLUSIVOS (30 DIAS 📆 – NÃO RENOVÁVEIS)
2.8GB - 100MT
5.8GB - 175MT
8.8GB - 200MT
10.8GB - 249MT
12.8GB - 300MT
15.8GB - 349MT
18.8GB - 400MT
20.8GB - 449MT
25.8GB - 549MT
32.8GB - 649MT
51.2GB - 1049MT
60.2GB - 1249MT
80.2GB - 1449MT
100.2GB - 1700MT
Observação: Pacotes mensais não compatíveis com Txuna

CHAMADAS ILIMITADAS — VODACOM 📞 ♾

11GB - 449MT - Ilimitadas ✨
14.5GB - 500MT - Ilimitadas
26.5GB - 700MT - Ilimitadas
37.5GB - 1000MT - Ilimitadas
53.5GB - 1500MT - Ilimitadas
102.5GB - 2150MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

CHAMADAS ILIMITADAS — MOVITEL 📞 ♾

9GB - 469MT - Ilimitadas ✨
23GB - 950MT - Ilimitadas
38GB - 1450MT - Ilimitadas
46GB - 1700MT - Ilimitadas
53GB - 1900MT - Ilimitadas
68GB - 2400MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

🔹 CONEXÃO SEM LIMITES 🔹
Internet rápida, chamadas e SMS ilimitadas.
Pacotes exclusivos Vodacom e Movitel.
Sempre conectado, sempre no controle!
`,

        pagamento: `💸 FORMAS DE PAGAMENTO

🟠 E-Mola – Glória | 📲 860186270  
🔴 M-Pesa – Leonor | 📲 857451196  

⚠ ATENÇÃO  
▪ Após o pagamento, envie a confirmação ✉ ** e o seu número para receber o seu pacote 📲  
▪ Envie ** o valor exato da tabela 💰  

NB: Válido apenas para Vodacom  
🚀 Garanta seus Megabytes agora!
`
    },
'120363420106859235@g.us': {
        nome: 'MozStreaming MB’s v3*',
        tabela: `📢🔥 TABELA ATUALIZADA – OUTUBRO 2025 🔥📢
Internet e Chamadas Ilimitadas – Vodacom
Pacotes Diários | Semanais | Mensais

OFERTA ESPECIAL – 24 HORAS ⏱
600MB - 10MT
800MB - 15MT
1024MB - 17MT
1200MB - 20MT
2048MB - 34MT

PACOTES DIÁRIOS (24H ⏱)
2400MB - 40MT
3072MB - 51MT
4096MB - 68MT
5120MB - 85MT
6144MB - 102MT
7168MB - 119MT
8192MB - 136MT
9144MB - 153MT
10240MB - 170MT

PACOTES PREMIUM (3 DIAS 🗓 – RENOVÁVEIS)
2000MB - 44MT
3000MB - 66MT
4000MB - 88MT
5000MB - 109MT
6000MB - 133MT
7000MB - 149MT
10000MB - 219MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 3 dias

SEMANAIS BÁSICOS (5 DIAS 🗓 – RENOVÁVEIS)
1700MB - 45MT
2900MB - 80MT
3400MB - 110MT
5500MB - 150MT
7800MB - 200MT
11400MB - 300MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 5 dias

SEMANAIS PREMIUM (15 DIAS 🗓 – RENOVÁVEIS)
3000MB - 100MT
5000MB - 149MT
8000MB - 201MT
10000MB - 231MT
20000MB - 352MT
Bônus 🔄: Receba 100MB extras para atualizar os megas dentro de 15 dias

PACOTES MENSAIS EXCLUSIVOS (30 DIAS 📆 – NÃO RENOVÁVEIS)
2.8GB - 100MT
5.8GB - 175MT
8.8GB - 200MT
10.8GB - 249MT
12.8GB - 300MT
15.8GB - 349MT
18.8GB - 400MT
20.8GB - 449MT
25.8GB - 549MT
32.8GB - 649MT
51.2GB - 1049MT
60.2GB - 1249MT
80.2GB - 1449MT
100.2GB - 1700MT
Observação: Pacotes mensais não compatíveis com Txuna

CHAMADAS ILIMITADAS — VODACOM 📞 ♾

11GB - 449MT - Ilimitadas ✨
14.5GB - 500MT - Ilimitadas
26.5GB - 700MT - Ilimitadas
37.5GB - 1000MT - Ilimitadas
53.5GB - 1500MT - Ilimitadas
102.5GB - 2150MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

CHAMADAS ILIMITADAS — MOVITEL 📞 ♾

9GB - 469MT - Ilimitadas ✨
23GB - 950MT - Ilimitadas
38GB - 1450MT - Ilimitadas
46GB - 1700MT - Ilimitadas
53GB - 1900MT - Ilimitadas
68GB - 2400MT - Ilimitadas
Inclui chamadas e SMS ilimitadas para todas as redes

🔹 CONEXÃO SEM LIMITES 🔹
Internet rápida, chamadas e SMS ilimitadas.
Pacotes exclusivos Vodacom e Movitel.
Sempre conectado, sempre no controle!
`,

        pagamento: `FORMAS DE PAGAMENTO
📱 M-Pesa: 844345161 (Elton Matusse)
📱 E-Mola: 864524363 (Aleocha Matusse)

📩 Envie o comprovativo, após o pagamento e o número que receberá os dados!
`
    },
'120363422150610418@g.us': {
        nome: 'MozStreaming MB’s vV3*',
        tabela: `TABELA ATUALIZADA

INTERNET & CHAMADAS ILIMITADAS 

Vodacom 
PACOTES DIÁRIOS — 24H

600MB = 10MT
800MB = 15MT
1024MB = 17MT
1200MB = 20MT
2048MB = 34MT

2400MB = 40MT
3072MB = 51MT
4096MB = 68MT
5120MB = 85MT
6144MB = 102MT
7168MB = 119MT
8192MB = 136MT
9144MB = 153MT
10240MB = 170MT

PACOTES PREMIUM — 3 DIAS (Renováveis)

2000MB = 44MT
3000MB = 66MT
4000MB = 88MT
5000MB = 109MT
6000MB = 133MT
7000MB = 149MT
10000MB = 219MT

Bônus: +100MB ao atualizar dentro de 3 dias

SEMANAIS BÁSICOS — 5 DIAS (Renováveis)

1700MB = 45MT
2900MB = 80MT
3400MB = 110MT
5500MB = 150MT
7800MB = 200MT
11400MB = 300MT

Bônus: +100MB ao atualizar dentro de 5 dias

PACOTES MENSAIS — 30 DIAS (Não Renováveis)

2.8GB = 100MT
5.8GB = 175MT
8.8GB = 200MT
10.8GB = 249MT
12.8GB = 300MT
15.8GB = 349MT
18.8GB = 400MT
20.8GB = 449MT
25.8GB = 549MT
32.8GB = 649MT
51.2GB = 1049MT
60.2GB = 1249MT
80.2GB = 1449MT
100.2GB = 1700MT

Observação: Pacotes mensais não compatíveis com Txuna

CHAMADAS ILIMITADAS — VODACOM

11GB = 449MT
14.5GB = 500MT
26.5GB = 700MT
37.5GB = 1000MT
53.5GB = 1500MT
102.5GB = 2150MT

CHAMADAS ILIMITADAS — MOVITEL

9GB = 469MT
23GB = 950MT
38GB = 1450MT
46GB = 1700MT
53GB = 1900MT
68GB = 2400MT

CONEXÃO SEM LIMITES

Internet rápida • Chamadas ilimitadas • SMS ilimitados
Pacotes atualizados e confiáveis.`,

        pagamento: `💸 FORMAS DE PAGAMENTO

🟠 E-Mola – Glória | 📲 860186270  
🔴 M-Pesa – Leonor | 📲 857451196  

⚠ ATENÇÃO  
▪ Após o pagamento, envie a confirmação ✉ ** e o seu número para receber o seu pacote 📲  
▪ Envie ** o valor exato da tabela 💰  

NB: Válido apenas para Vodacom  
🚀 Garanta seus Megabytes agora!`
    }
};


// === FUNÇÃO GOOGLE SHEETS ===

// Função para retry automático
async function tentarComRetry(funcao, maxTentativas = 3, delay = 2000) {
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            return await funcao();
        } catch (error) {
            console.log(`⚠️ Tentativa ${tentativa}/${maxTentativas} falhou: ${error.message}`);
            
            if (tentativa === maxTentativas) {
                throw error; // Última tentativa, propagar erro
            }
            
            // Aguardar antes da próxima tentativa
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
async function enviarParaGoogleSheets(referencia, valor, numero, grupoId, grupoNome, autorMensagem) {
    // AGUARDAR RATE LIMIT ANTES DE ENVIAR
    await aguardarRateLimit();

    // Formato igual ao Bot Atacado: transacao já concatenada
    const transacaoFormatada = `${referencia}|${valor}|${numero}`;

    const dados = {
        transacao: transacaoFormatada,  // Formato concatenado igual ao Bot Atacado
        grupo_id: grupoId,
        sender: 'WhatsApp-Bot',  // Identificar origem
        message: `Dados enviados pelo Bot: ${transacaoFormatada}`,
        timestamp: new Date().toISOString()
    };

    try {
        console.log(`📊 Enviando para API MariaDB: ${referencia}`);
        console.log(`🔍 Dados enviados:`, JSON.stringify(dados, null, 2));
        console.log(`🔗 URL destino:`, API_PEDIDOS_CONFIG.scriptUrl);

        // Usar axios COM RETRY para API MariaDB
        const response = await axiosComRetry({
            method: 'post',
            url: API_PEDIDOS_CONFIG.scriptUrl,
            data: dados,
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Source': 'WhatsApp-Bot-Pooled'
            }
        }, 3); // 3 tentativas
        
        // Google Apps Script agora retorna JSON
        const responseData = response.data;
        console.log(`📥 Resposta API MariaDB:`, JSON.stringify(responseData, null, 2));

        // Verificar se é uma resposta JSON válida
        if (typeof responseData === 'object') {
            if (responseData.success) {
                console.log(`✅ API MariaDB: Dados enviados!`);
                return { sucesso: true, referencia: responseData.referencia, duplicado: false };
            } else if (responseData.duplicado) {
                console.log(`⚠️ API MariaDB: Pedido duplicado detectado - ${responseData.referencia} (Status: ${responseData.status_existente})`);
                return {
                    sucesso: false,
                    duplicado: true,
                    referencia: responseData.referencia,
                    status_existente: responseData.status_existente,
                    message: responseData.message
                };
            } else {
                throw new Error(responseData.message || 'Erro desconhecido');
            }
        } else {
            // Fallback para compatibilidade com resposta em texto
            const responseText = String(responseData);
            if (responseText.includes('Sucesso!')) {
                console.log(`✅ API MariaDB: Dados enviados!`);
                return { sucesso: true, row: 'N/A', duplicado: false };
            } else if (responseText.includes('Erro:')) {
                throw new Error(responseText);
            } else {
                throw new Error(`Resposta inesperada: ${responseText}`);
            }
        }

    } catch (error) {
        // Tratar erro 429 especificamente
        if (error.response && error.response.status === 429) {
            erros429Consecutivos++;
            console.error(`🚨 API MariaDB: Rate limit atingido (429) - Erro ${erros429Consecutivos}/${MAX_ERROS_429}`);

            // Pausar se necessário
            if (erros429Consecutivos >= MAX_ERROS_429) {
                const pausaEmergencia = 2 * 60 * 1000;
                console.error(`⏸️ API MariaDB: Pausando envios por ${pausaEmergencia/1000}s devido a múltiplos erros 429`);
                await new Promise(resolve => setTimeout(resolve, pausaEmergencia));
                erros429Consecutivos = 0;
            }
            return { sucesso: false, erro: 'Rate limit atingido, tentando novamente em instantes...' };
        }

        console.error(`❌ Erro API MariaDB [${grupoNome}]: ${error.message}`);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO PARA ENVIAR PACOTES ESPECIAIS (DIAMANTE, 2.8GB, ETC) ===
async function enviarParaGoogleSheetsDiamante(referencia, numero, codigoPacote, grupoId, grupoNome, autorMensagem) {
    // AGUARDAR RATE LIMIT ANTES DE ENVIAR
    await aguardarRateLimit();

    // Formato NOVO: REF|CODIGO|NUMERO
    // CODIGO: 1=Diamante, 2=Pacote 2.8GB, etc.
    const transacaoFormatada = `${referencia}|${codigoPacote}|${numero}`;

    // Obter nome do pacote para logs
    const infoPacote = CODIGOS_PACOTES_ESPECIAIS[codigoPacote] || { nome: 'Especial', emoji: '📦' };

    const dados = {
        transacao: transacaoFormatada,
        grupo_id: grupoId,
        sender: `WhatsApp-Bot-${infoPacote.nome}`,
        message: `Pedido ${infoPacote.emoji} ${infoPacote.nome} enviado pelo Bot: ${transacaoFormatada}`,
        timestamp: new Date().toISOString()
    };

    try {
        console.log(`💎 Enviando para API MariaDB DIAMANTE: ${referencia}`);
        console.log(`🔍 Dados enviados:`, JSON.stringify(dados, null, 2));
        console.log(`🔗 URL destino:`, API_DIAMANTE_CONFIG.scriptUrl);

        // Usar axios COM RETRY para API MariaDB Diamante
        const response = await axiosComRetry({
            method: 'post',
            url: API_DIAMANTE_CONFIG.scriptUrl,
            data: dados,
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Source': 'WhatsApp-Bot-Diamante'
            }
        }, 3); // 3 tentativas

        const responseData = response.data;
        console.log(`📥 Resposta API MariaDB Diamante:`, JSON.stringify(responseData, null, 2));

        // Verificar se é uma resposta JSON válida
        if (typeof responseData === 'object') {
            if (responseData.success) {
                console.log(`✅ API MariaDB Diamante: Dados enviados!`);
                return { sucesso: true, referencia: responseData.referencia, duplicado: false };
            } else if (responseData.duplicado) {
                console.log(`⚠️ API MariaDB Diamante: Pedido duplicado detectado - ${responseData.referencia} (Status: ${responseData.status_existente})`);
                return {
                    sucesso: false,
                    duplicado: true,
                    referencia: responseData.referencia,
                    status_existente: responseData.status_existente,
                    message: responseData.message
                };
            } else {
                throw new Error(responseData.message || 'Erro desconhecido');
            }
        } else {
            // Fallback para compatibilidade com resposta em texto
            const responseText = String(responseData);
            if (responseText.includes('Sucesso!')) {
                console.log(`✅ API MariaDB Diamante: Dados enviados!`);
                return { sucesso: true, row: 'N/A', duplicado: false };
            } else if (responseText.includes('Erro:')) {
                throw new Error(responseText);
            } else {
                throw new Error(`Resposta inesperada: ${responseText}`);
            }
        }

    } catch (error) {
        // Tratar erro 429 especificamente
        if (error.response && error.response.status === 429) {
            erros429Consecutivos++;
            console.error(`🚨 API MariaDB Diamante: Rate limit atingido (429) - Erro ${erros429Consecutivos}/${MAX_ERROS_429}`);

            // Pausar se necessário
            if (erros429Consecutivos >= MAX_ERROS_429) {
                const pausaEmergencia = 2 * 60 * 1000;
                console.error(`⏸️ API MariaDB Diamante: Pausando envios por ${pausaEmergencia/1000}s devido a múltiplos erros 429`);
                await new Promise(resolve => setTimeout(resolve, pausaEmergencia));
                erros429Consecutivos = 0;
            }
            return { sucesso: false, erro: 'Rate limit atingido, tentando novamente em instantes...' };
        }

        console.error(`❌ Erro API MariaDB Diamante [${grupoNome}]: ${error.message}`);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO PARA PROCESSAR PACOTES ESPECIAIS (DIAMANTE, 2.8GB, ETC) ===
async function processarPacoteDiamante(comprovante, configGrupo, pacoteDiamante) {
    try {
        const { referencia, valor, numero } = comprovante;
        const grupoId = configGrupo.grupoId;
        const grupoNome = configGrupo.nome;

        // Identificar código do pacote baseado no tipo
        let codigoPacote = 1; // Padrão: Diamante
        let gbBase = 11; // GB base para divisão (padrão diamante)

        // Identificar tipo de pacote especial
        if (pacoteDiamante.isDiamante) {
            codigoPacote = 1;
            gbBase = CODIGOS_PACOTES_ESPECIAIS[1].gbBase;
        } else if (pacoteDiamante.tipo === 'pacote_2_8gb' || pacoteDiamante.descricao.includes('2.8GB') || pacoteDiamante.descricao.includes('2,8GB')) {
            codigoPacote = 2;
            gbBase = CODIGOS_PACOTES_ESPECIAIS[2].gbFixo;
        }

        const infoPacote = CODIGOS_PACOTES_ESPECIAIS[codigoPacote];

        console.log(`${infoPacote.emoji} ${infoPacote.nome.toUpperCase()}: Processando pacote especial`);
        console.log(`${infoPacote.emoji} Ref: ${referencia} | Valor: ${valor}MT | Número: ${numero}`);
        console.log(`${infoPacote.emoji} Pacote: ${pacoteDiamante.descricao} (${pacoteDiamante.quantidade}MB)`);

        // Converter MB para GB
        const totalGB = Math.round(pacoteDiamante.quantidade / 1024);
        console.log(`${infoPacote.emoji} Total GB: ${totalGB}GB`);

        // === CASO 1: Pacote até GB base (SIMPLES - SEM DIVISÃO) ===
        if (totalGB <= gbBase) {
            console.log(`${infoPacote.emoji} ${infoPacote.nome}: Pacote ≤${gbBase}GB, enviando direto para planilha especial`);

            // Enviar direto para planilha de pacotes especiais
            const resultado = await enviarParaGoogleSheetsDiamante(
                referencia,
                numero,
                codigoPacote,
                grupoId,
                grupoNome,
                'WhatsApp-Bot'
            );

            if (resultado.sucesso) {
                console.log(`✅ ${infoPacote.nome}: Pacote enviado com sucesso!`);
                return {
                    sucesso: true,
                    mensagem: `${infoPacote.emoji} *${infoPacote.nome.toUpperCase()} PROCESSADO*\n\n✅ Seu pacote foi enviado para processamento!\n\n📱 Número: ${numero}\n${infoPacote.emoji} Pacote: ${pacoteDiamante.descricao}\n🔖 Referência: ${referencia}\n\n⏰ Aguarde a ativação em instantes!`
                };
            } else {
                throw new Error(resultado.erro || 'Erro ao enviar para planilha de pacotes especiais');
            }
        }

        // === CASO 2: Pacote > GB base (COMPLEXO - COM DIVISÃO) ===
        console.log(`${infoPacote.emoji} ${infoPacote.nome}: Pacote >${gbBase}GB, iniciando divisão`);

        const gbDiamante = gbBase;
        const gbExtras = totalGB - gbDiamante;
        console.log(`${infoPacote.emoji} ${infoPacote.nome}: ${totalGB}GB = ${gbDiamante}GB (${infoPacote.identificador}) + ${gbExtras}GB (extras)`);

        // Calcular divisões dos GB extras (limite 10GB por transação)
        const divisoes = [];
        let gbRestante = gbExtras * 1024; // Converter para MB
        let contadorDivisao = 1;

        while (gbRestante > 0) {
            const mbDivisao = Math.min(gbRestante, 10240); // Máximo 10GB por transação
            const refDivisao = `${referencia}${String(contadorDivisao).padStart(2, '0')}`;

            divisoes.push({
                referencia: refDivisao,
                megas: mbDivisao,
                numero: numero
            });

            gbRestante -= mbDivisao;
            contadorDivisao++;
        }

        console.log(`${infoPacote.emoji} ${infoPacote.nome}: ${gbExtras}GB divididos em ${divisoes.length} transação(ões):`);
        divisoes.forEach((div, i) => {
            console.log(`   ${i + 1}. ${div.referencia} = ${div.megas}MB`);
        });

        // Adicionar ao cache de pacotes especiais pendentes
        pacotesDiamantePendentes[referencia] = {
            referencia: referencia,
            numero: numero,
            codigoPacote: codigoPacote,
            totalGB: totalGB,
            gbDiamante: gbDiamante,
            gbExtras: gbExtras,
            divisoes: divisoes.map(d => d.referencia),
            confirmacoesRecebidas: [],
            grupoId: grupoId,
            grupoNome: grupoNome,
            timestamp: Date.now()
        };

        console.log(`${infoPacote.emoji} ${infoPacote.nome}: Adicionado ao cache de pendentes`);

        // Enviar divisões para planilha comum (sistema existente)
        for (const divisao of divisoes) {
            console.log(`📤 Enviando divisão: ${divisao.referencia} = ${divisao.megas}MB`);

            const resultado = await enviarParaGoogleSheets(
                divisao.referencia,
                divisao.megas,
                divisao.numero,
                grupoId,
                grupoNome,
                'WhatsApp-Bot-Diamante-Divisao'
            );

            if (!resultado.sucesso) {
                console.error(`❌ Erro ao enviar divisão ${divisao.referencia}`);
                // Continuar enviando outras divisões
            }
        }

        console.log(`✅ ${infoPacote.nome}: Todas as divisões enviadas para planilha comum`);
        console.log(`⏳ ${infoPacote.nome}: Aguardando confirmações do bot secundário...`);

        return {
            sucesso: true,
            mensagem: `${infoPacote.emoji} *${infoPacote.nome.toUpperCase()} PROCESSADO*\n\n✅ Seu pacote está sendo processado!\n\n📱 Número: ${numero}\n${infoPacote.emoji} Pacote: ${pacoteDiamante.descricao}\n🔖 Referência: ${referencia}\n\n📊 *Divisão:*\n• ${gbExtras}GB de megas comuns (processando...)\n• ${gbDiamante}GB + ${infoPacote.descricao} (aguardando)\n\n⏰ O ${infoPacote.nome.toLowerCase()} será ativado assim que os megas extras forem confirmados!`
        };

    } catch (error) {
        console.error(`❌ DIAMANTE: Erro ao processar pacote:`, error.message);
        return {
            sucesso: false,
            erro: error.message
        };
    }
}

// === FUNÇÃO PARA PROCESSAR PACOTES .8GB (12.8, 22.8, etc.) ===
async function processarPacotePonto8(comprovante, configGrupo, pacoteDiamante) {
    try {
        const { referencia, valor, numero } = comprovante;

        // Verificação de segurança para configGrupo
        if (!configGrupo) {
            console.error(`❌ PACOTE .8GB: configGrupo está undefined!`);
            throw new Error('Configuração do grupo não encontrada');
        }

        const grupoId = configGrupo.grupoId;
        const grupoNome = configGrupo.nome || 'Desconhecido';

        console.log(`📦 PACOTE .8GB: Processando pacote especial .8GB`);
        console.log(`📦 Ref: ${referencia} | Valor: ${valor}MT | Número: ${numero}`);
        console.log(`📦 Grupo ID: ${grupoId} | Nome: ${grupoNome}`);
        console.log(`📦 Pacote: ${pacoteDiamante.descricao} (${pacoteDiamante.gbTotal}GB total)`);

        const totalGB = pacoteDiamante.gbTotal; // Ex: 12.8, 22.8, etc.
        const gbComuns = totalGB - 2.8; // Ex: 10, 20, etc.
        const gb28 = 2.8;

        console.log(`📦 DIVISÃO: ${totalGB}GB = ${gbComuns}GB (comuns) + ${gb28}GB (especial código 2)`);

        // === PASSO 1: Calcular divisões dos GB comuns (limite 10GB por transação) ===
        const divisoes = [];
        let gbRestante = gbComuns * 1024; // Converter para MB
        let contadorDivisao = 1;

        while (gbRestante > 0) {
            const mbDivisao = Math.min(gbRestante, 10240); // Máximo 10GB por transação
            const refDivisao = `${referencia}${String(contadorDivisao).padStart(2, '0')}`;

            divisoes.push({
                referencia: refDivisao,
                megas: mbDivisao,
                numero: numero
            });

            gbRestante -= mbDivisao;
            contadorDivisao++;
        }

        console.log(`📦 ${gbComuns}GB comuns divididos em ${divisoes.length} transação(ões):`);
        divisoes.forEach((div, i) => {
            console.log(`   ${i + 1}. ${div.referencia} = ${div.megas}MB`);
        });

        // === PASSO 2: Adicionar ao cache de pacotes .8GB pendentes ===
        pacotesDiamantePendentes[referencia] = {
            referencia: referencia,
            numero: numero,
            codigoPacote: 2, // Código 2 para os 2.8GB
            totalGB: totalGB,
            gbComuns: gbComuns,
            gb28: gb28,
            divisoes: divisoes.map(d => d.referencia),
            confirmacoesRecebidas: [],
            grupoId: grupoId,
            grupoNome: grupoNome,
            timestamp: Date.now(),
            tipo: 'pacote_ponto_8gb'
        };

        console.log(`📦 Adicionado ao cache de pendentes (tipo: pacote_ponto_8gb)`);

        // === PASSO 3: Enviar divisões comuns para planilha comum ===
        for (const divisao of divisoes) {
            console.log(`📤 Enviando divisão comum: ${divisao.referencia} = ${divisao.megas}MB`);

            const resultado = await enviarParaGoogleSheets(
                divisao.referencia,
                divisao.megas,
                divisao.numero,
                grupoId,
                grupoNome,
                'WhatsApp-Bot-Ponto8-Divisao'
            );

            if (!resultado.sucesso) {
                console.error(`❌ Erro ao enviar divisão ${divisao.referencia}`);
                // Continuar enviando outras divisões
            }
        }

        console.log(`✅ PACOTE .8GB: Todas as divisões comuns enviadas`);
        console.log(`⏳ PACOTE .8GB: Aguardando confirmações para enviar os 2.8GB especiais...`);

        // === PASSO 4: Retornar mensagem ao cliente ===
        return {
            sucesso: true,
            mensagem: `📦 *PACOTE ${totalGB}GB PROCESSADO*\n\n✅ Seu pacote está sendo processado!\n\n📱 Número: ${numero}\n📦 Pacote: ${pacoteDiamante.descricao}\n🔖 Referência: ${referencia}\n\n📊 *Divisão:*\n• ${gbComuns}GB comuns (processando...)\n• ${gb28}GB mensais código 2 (aguardando confirmação)\n\n⏰ O pacote completo será ativado após confirmação dos megas comuns!`
        };

    } catch (error) {
        console.error(`❌ PACOTE .8GB: Erro ao processar:`, error.message);
        return {
            sucesso: false,
            erro: error.message
        };
    }
}

// === FUNÇÃO PRINCIPAL PARA TASKER ===
async function enviarParaTasker(referencia, valor, numero, grupoId, autorMensagem, valorMT = null) {
    const grupoNome = getConfiguracaoGrupo(grupoId)?.nome || 'Desconhecido';
    const timestamp = new Date().toLocaleString('pt-BR');
    const linhaCompleta = `${referencia}|${valor}|${numero}`;

    console.log(`📊 ENVIANDO PARA GOOGLE SHEETS [${grupoNome}]: ${linhaCompleta}`);

    // === VALIDAÇÕES PREVENTIVAS ===
    if (!referencia || !valor || !numero) {
        console.error(`❌ VALIDAÇÃO FALHOU: Dados incompletos - referencia=${referencia}, valor=${valor}, numero=${numero}`);
        return {
            sucesso: false,
            erro: 'Dados incompletos para envio'
        };
    }

    // Validar formato da referência
    if (typeof referencia !== 'string' || referencia.length < 3) {
        console.error(`❌ VALIDAÇÃO FALHOU: Referência inválida - ${referencia}`);
        return {
            sucesso: false,
            erro: 'Referência inválida'
        };
    }

    // Validar número
    const numeroLimpo = String(numero).replace(/[^0-9]/g, '');
    if (numeroLimpo.length < 9) {
        console.error(`❌ VALIDAÇÃO FALHOU: Número inválido - ${numero}`);
        return {
            sucesso: false,
            erro: 'Número de telefone inválido'
        };
    }

    // Validar URL do API MariaDB
    if (!API_PEDIDOS_CONFIG.scriptUrl || API_PEDIDOS_CONFIG.scriptUrl === '') {
        console.error(`❌ VALIDAÇÃO FALHOU: URL do API MariaDB não configurada`);
        return {
            sucesso: false,
            erro: 'API MariaDB não configurado'
        };
    }

    // Cache da transação
    const transacaoKey = `${grupoId}_${Date.now()}_${numero}`;
    cacheTransacoes.set(transacaoKey, {
        dados: linhaCompleta,
        grupo_id: grupoId,
        grupo: grupoNome,
        autor: autorMensagem,
        timestamp: timestamp,
        enviado: false,
        metodo: 'pendente'
    });

    // === TENTAR GOOGLE SHEETS COM RETRY ===
    let tentativas = 0;
    let resultado = null;
    const maxTentativas = 3;

    while (tentativas < maxTentativas) {
        tentativas++;

        try {
            console.log(`🔄 Tentativa ${tentativas}/${maxTentativas} de envio para API MariaDB...`);
            resultado = await enviarParaGoogleSheets(referencia, valor, numero, grupoId, grupoNome, autorMensagem);

            if (resultado.sucesso) {
                break; // Sucesso, sair do loop
            } else if (resultado.duplicado) {
                break; // Duplicado, sair do loop (não tentar novamente)
            } else {
                console.warn(`⚠️ Tentativa ${tentativas} falhou:`, resultado.erro || 'Erro desconhecido');

                // Aguardar antes de tentar novamente (exceto na última tentativa)
                if (tentativas < maxTentativas) {
                    const delay = tentativas * 2000; // 2s, 4s
                    console.log(`⏳ Aguardando ${delay/1000}s antes da próxima tentativa...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        } catch (error) {
            console.error(`❌ Erro na tentativa ${tentativas}:`, error.message);

            // Aguardar antes de tentar novamente (exceto na última tentativa)
            if (tentativas < maxTentativas) {
                const delay = tentativas * 2000;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    if (resultado && resultado.sucesso) {
        // Atualizar cache
        if (cacheTransacoes.has(transacaoKey)) {
            const transacao = cacheTransacoes.get(transacaoKey);
            transacao.enviado = true;
            transacao.metodo = 'google_sheets';
            transacao.row = resultado.row;
        }
        console.log(`✅ [${grupoNome}] Enviado para API MariaDB com sucesso! Row: ${resultado.row}`);

        // === REGISTRAR COMPRA PENDENTE NO SISTEMA DE COMPRAS ===
        if (sistemaCompras) {
            try {
                // Extrair apenas o número do autorMensagem (remover @c.us se houver)
                const numeroRemetente = autorMensagem.replace('@c.us', '');
                console.log(`🔍 DEBUG COMPRA: autorMensagem="${autorMensagem}" | numeroRemetente="${numeroRemetente}" | numero="${numero}"`);
                await sistemaCompras.registrarCompraPendente(referencia, numero, valor, numeroRemetente, grupoId);
            } catch (error) {
                console.error('❌ Erro ao registrar compra pendente:', error);
                // Não falhar o envio por causa disso
            }
        }

        // === DETECTAR E ATIVAR PACOTES AUTOMÁTICOS (3, 5, 15 DIAS) ===
        if (sistemaPacotes && CONFIGURACAO_GRUPOS[grupoId]) {
            try {
                const tabelaGrupo = CONFIGURACAO_GRUPOS[grupoId].tabela;

                // Extrair pacotes renováveis da tabela para fazer lookup
                const pacotesRenovaveis = sistemaPacotes.extrairPacotesRenovaveis(tabelaGrupo);

                // Procurar o valor em MT correspondente aos MB
                let valorMTEncontrado = null;
                let tipoPacoteDetectado = null;

                for (const [tipoDias, listaPacotes] of Object.entries(pacotesRenovaveis)) {
                    for (const pacote of listaPacotes) {
                        // Comparar MB com tolerância de 1%
                        const mbMatch = Math.abs(pacote.mb - valor) <= (valor * 0.01);

                        // Se valorMT foi fornecido, também comparar o valor MT
                        const mtMatch = valorMT ? (parseInt(pacote.valor) === parseInt(valorMT)) : true;

                        if (mbMatch && mtMatch) {
                            valorMTEncontrado = pacote.valor;
                            tipoPacoteDetectado = tipoDias;
                            break;
                        }
                    }
                    if (tipoPacoteDetectado) break;
                }

                if (tipoPacoteDetectado && valorMTEncontrado) {
                    console.log(`🎯 PACOTES: Detectado pacote de ${tipoPacoteDetectado} dias - Ativando automaticamente!`);
                    console.log(`   📋 Referência: ${referencia}`);
                    console.log(`   📱 Número: ${numero}`);
                    console.log(`   💰 Valor Pago: ${valorMT || 'N/A'}MT`);
                    console.log(`   💰 Valor do Pacote: ${valorMTEncontrado}MT`);
                    console.log(`   📊 Megas: ${valor}MB`);

                    // Ativar pacote automático
                    const resultadoPacote = await sistemaPacotes.processarComprovante(
                        referencia,
                        numero,
                        grupoId,
                        tipoPacoteDetectado,
                        valor, // Megas do pacote inicial (ex: 2000MB)
                        valorMTEncontrado // Valor em MT do pacote inicial (ex: 44MT)
                    );

                    if (resultadoPacote.sucesso) {
                        console.log(`✅ PACOTES: Pacote automático ativado com sucesso!`);
                        console.log(`   📅 Primeira renovação: ${new Date(resultadoPacote.cliente.proximaRenovacao).toLocaleString('pt-BR')}`);

                        // Enviar notificação ao grupo
                        try {
                            const primeiraRenovacaoData = new Date(resultadoPacote.cliente.proximaRenovacao);
                            const dataExpiracao = new Date(resultadoPacote.cliente.dataExpiracao);
                            const nomeTipoPacote = sistemaPacotes.TIPOS_PACOTES[tipoPacoteDetectado].nome;

                            const mensagemNotificacao =
                                `🎉 *PACOTE AUTOMÁTICO ATIVADO!*\n\n` +
                                `📱 *Número:* ${numero}\n` +
                                `📦 *Tipo:* ${nomeTipoPacote}\n` +
                                `📊 *Pacote:* ${valor}MB\n` +
                                `💰 *Valor:* ${valorMTEncontrado}MT\n` +
                                `📋 *Referência:* ${referencia}\n\n` +
                                `🔄 *Renovações Automáticas Agendadas:*\n` +
                                `   • Total: ${tipoPacoteDetectado} renovações de 100MB\n` +
                                `   • Primeira: ${primeiraRenovacaoData.toLocaleDateString('pt-BR')} às ${primeiraRenovacaoData.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}\n` +
                                `   • Frequência: Diária (2h antes do horário anterior)\n\n` +
                                `📅 *Validade Total:* Até ${dataExpiracao.toLocaleDateString('pt-BR')}\n\n` +
                                `💡 *Como funciona:*\n` +
                                `O sistema enviará automaticamente 100MB por dia durante ${tipoPacoteDetectado} dias para manter seu pacote principal válido.\n\n` +
                                `✨ *Total de dados:* ${valor}MB + ${parseInt(tipoPacoteDetectado) * 100}MB bônus = ${parseInt(valor) + (parseInt(tipoPacoteDetectado) * 100)}MB!`;

                            await client.sendMessage(grupoId, mensagemNotificacao);
                            console.log(`📢 Notificação de pacote automático enviada ao grupo!`);
                        } catch (errorNotificacao) {
                            console.error(`❌ Erro ao enviar notificação de pacote automático:`, errorNotificacao.message);
                            // Não falhar a ativação por causa da notificação
                        }
                    } else {
                        console.error(`❌ PACOTES: Erro ao ativar pacote automático: ${resultadoPacote.erro}`);
                    }
                }
            } catch (error) {
                console.error('❌ Erro ao detectar/ativar pacote automático:', error);
                // Não falhar o envio por causa disso
            }
        }

        return {
            sucesso: true,
            referencia: referencia,
            row: resultado.row,
            linhaCompleta: linhaCompleta
        };

    } else if (resultado && resultado.duplicado) {
        // Marcar como duplicado no cache
        if (cacheTransacoes.has(transacaoKey)) {
            cacheTransacoes.get(transacaoKey).status = 'duplicado';
        }
        console.log(`🛑 [${grupoNome}] Pedido duplicado detectado: ${referencia}`);

        // Retornar informações do duplicado para o bot processar
        return {
            sucesso: false,
            duplicado: true,
            referencia: resultado.referencia,
            status_existente: resultado.status_existente,
            message: resultado.message
        };
    } else {
        // Todas as tentativas falharam
        console.error(`❌ [${grupoNome}] TODAS AS ${maxTentativas} TENTATIVAS FALHARAM para ${referencia}`);
        if (cacheTransacoes.has(transacaoKey)) {
            cacheTransacoes.get(transacaoKey).metodo = 'falhou';
        }

        return {
            sucesso: false,
            erro: resultado?.erro || 'Falha ao enviar para API MariaDB após múltiplas tentativas',
            tentativas: maxTentativas
        };
    }
}

// REMOVIDO: Função enviarViaWhatsAppTasker
// (Sistema de encaminhamento movido para outro bot)

// === FUNÇÃO REMOVIDA PARA OTIMIZAÇÃO ===
// Não salva mais arquivos .txt desnecessários
// async function salvarArquivoTasker() - REMOVIDA

function obterDadosTasker() {
    return Array.from(cacheTransacoes.values());
}

function obterDadosTaskerHoje() {
    const hoje = new Date().toDateString();
    return Array.from(cacheTransacoes.values()).filter(item => {
        const dataItem = new Date(item.timestamp).toDateString();
        return dataItem === hoje;
    });
}

// === FUNÇÕES PARA TASKER - SISTEMA DE PACOTES ===
function obterDadosPacotesTasker() {
    if (!sistemaPacotes) return [];
    
    const clientes = Object.values(sistemaPacotes.clientesAtivos);
    return clientes.map(cliente => ({
        numero: cliente.numero,
        referenciaOriginal: cliente.referenciaOriginal,
        tipoPacote: cliente.tipoPacote,
        diasRestantes: cliente.diasRestantes,
        proximaRenovacao: cliente.proximaRenovacao,
        status: cliente.status,
        grupoId: cliente.grupoId
    }));
}

function obterRenovacoesPendentesTasker() {
    if (!sistemaPacotes) return [];
    
    const agora = new Date();
    const proximas6h = new Date(agora.getTime() + (6 * 60 * 60 * 1000));
    
    const clientes = Object.values(sistemaPacotes.clientesAtivos);
    return clientes.filter(cliente => {
        const proximaRenovacao = new Date(cliente.proximaRenovacao);
        return proximaRenovacao <= proximas6h && cliente.diasRestantes > 0;
    }).map(cliente => ({
        numero: cliente.numero,
        referenciaOriginal: cliente.referenciaOriginal,
        tipoPacote: cliente.tipoPacote,
        proximaRenovacao: cliente.proximaRenovacao,
        diasRestantes: cliente.diasRestantes
    }));
}

// === COMANDOS CUSTOMIZADOS - FUNÇÕES ===

let gatilhosAutomaticos = {}; // { chatId: { gatilho: { resposta, criadoPor, criadoEm } } }
const ARQUIVO_GATILHOS = './gatilhos_automaticos.json';

async function carregarComandosCustomizados() {
    try {
        const data = await fs.readFile(ARQUIVO_COMANDOS, 'utf8');
        comandosCustomizados = JSON.parse(data);
        console.log(`📝 Comandos customizados carregados: ${Object.keys(comandosCustomizados).length} grupos`);
    } catch (error) {
        comandosCustomizados = {};
        console.log('📝 Arquivo de comandos não existe, criando estrutura vazia');
    }
}

async function carregarGatilhosAutomaticos() {
    try {
        const data = await fs.readFile(ARQUIVO_GATILHOS, 'utf8');
        gatilhosAutomaticos = JSON.parse(data);
        console.log(`🎯 Gatilhos automáticos carregados: ${Object.keys(gatilhosAutomaticos).length} grupos`);
    } catch (error) {
        gatilhosAutomaticos = {};
        console.log('🎯 Arquivo de gatilhos não existe, criando estrutura vazia');
    }
}

async function salvarComandosCustomizados() {
    try {
        await fs.writeFile(ARQUIVO_COMANDOS, JSON.stringify(comandosCustomizados));
        console.log('✅ Comandos customizados salvos');
    } catch (error) {
        console.error('❌ Erro ao salvar comandos:', error);
    }
}

async function salvarGatilhosAutomaticos() {
    try {
        await fs.writeFile(ARQUIVO_GATILHOS, JSON.stringify(gatilhosAutomaticos));
        console.log('✅ Gatilhos automáticos salvos');
    } catch (error) {
        console.error('❌ Erro ao salvar gatilhos:', error);
    }
}

function parsearComandoCustomizado(texto) {
    // Regex para capturar: .addcomando Nome do comando(resposta)
    // Aceita múltiplas palavras e caracteres especiais (ç, á, õ, etc)
    const regex = /^\.addcomando\s+(.+?)\s*\((.+)\)$/s;
    const match = texto.match(regex);

    if (match) {
        return {
            nome: match[1].trim().toLowerCase(),
            resposta: match[2].trim()
        };
    }
    return null;
}

function parsearGatilhoAutomatico(texto) {
    // Regex para capturar: .addgatilho Texto inicial(resposta)
    // Aceita múltiplas palavras e caracteres especiais
    const regex = /^\.addgatilho\s+(.+?)\s*\((.+)\)$/s;
    const match = texto.match(regex);

    if (match) {
        return {
            gatilho: match[1].trim().toLowerCase(),
            resposta: match[2].trim()
        };
    }
    return null;
}

async function adicionarComandoCustomizado(chatId, nomeComando, resposta, autorId) {
    if (!comandosCustomizados[chatId]) {
        comandosCustomizados[chatId] = {};
    }
    
    comandosCustomizados[chatId][nomeComando] = {
        resposta: resposta,
        criadoPor: autorId,
        criadoEm: new Date().toISOString()
    };
    
    await salvarComandosCustomizados();
    console.log(`✅ Comando '${nomeComando}' adicionado ao grupo ${chatId}`);
}

async function adicionarGatilhoAutomatico(chatId, gatilho, resposta, autorId) {
    if (!gatilhosAutomaticos[chatId]) {
        gatilhosAutomaticos[chatId] = {};
    }

    gatilhosAutomaticos[chatId][gatilho] = {
        resposta: resposta,
        criadoPor: autorId,
        criadoEm: new Date().toISOString()
    };

    await salvarGatilhosAutomaticos();
    console.log(`✅ Gatilho '${gatilho}' adicionado ao grupo ${chatId}`);
}

async function removerComandoCustomizado(chatId, nomeComando) {
    if (comandosCustomizados[chatId] && comandosCustomizados[chatId][nomeComando]) {
        delete comandosCustomizados[chatId][nomeComando];

        // Se não há mais comandos no grupo, remove a entrada do grupo
        if (Object.keys(comandosCustomizados[chatId]).length === 0) {
            delete comandosCustomizados[chatId];
        }

        await salvarComandosCustomizados();
        console.log(`🗑️ Comando '${nomeComando}' removido do grupo ${chatId}`);
        return true;
    }
    return false;
}

async function removerGatilhoAutomatico(chatId, gatilho) {
    if (gatilhosAutomaticos[chatId] && gatilhosAutomaticos[chatId][gatilho]) {
        delete gatilhosAutomaticos[chatId][gatilho];

        if (Object.keys(gatilhosAutomaticos[chatId]).length === 0) {
            delete gatilhosAutomaticos[chatId];
        }

        await salvarGatilhosAutomaticos();
        console.log(`🗑️ Gatilho '${gatilho}' removido do grupo ${chatId}`);
        return true;
    }
    return false;
}

function executarComandoCustomizado(chatId, comando) {
    if (comandosCustomizados[chatId] && comandosCustomizados[chatId][comando]) {
        return comandosCustomizados[chatId][comando].resposta;
    }
    return null;
}

function verificarGatilhoAutomatico(chatId, mensagem) {
    if (!gatilhosAutomaticos[chatId]) return null;

    const mensagemLower = mensagem.toLowerCase().trim();

    // Verifica cada gatilho do grupo
    for (const gatilho in gatilhosAutomaticos[chatId]) {
        if (mensagemLower.startsWith(gatilho)) {
            return gatilhosAutomaticos[chatId][gatilho].resposta;
        }
    }

    return null;
}

// === FUNÇÕES AUXILIARES ===

function detectarPerguntaPorNumero(mensagem) {
    const texto = mensagem.toLowerCase();
    
    const padroes = [
        /qual\s+(é\s+)?(o\s+)?número/i,
        /número\s+(de\s+)?(contato|suporte|atendimento)/i,
        /como\s+(falar|contactar|entrar em contacto)/i,
        /preciso\s+(de\s+)?(ajuda|suporte|número)/i,
        /onde\s+(posso\s+)?falar/i,
        /tem\s+(número|contacto|suporte)/i,
        /quero\s+falar\s+com/i,
        /atendimento/i,
        /suporte/i,
        /admin/i,
        /administrador/i,
        /responsável/i,
        /quem\s+(é\s+)?responsável/i,
        /como\s+contactar/i,
        /número\s+do\s+admin/i
    ];
    
    return padroes.some(padrao => padrao.test(texto));
}

function isAdministrador(numero) {
    // Se for @lid, tentar converter para @c.us ANTES de verificar cache
    let numeroParaVerificar = numero;

    if (numero.includes('@lid')) {
        // Verificar se está no mapeamento
        if (MAPEAMENTO_IDS[numero]) {
            numeroParaVerificar = MAPEAMENTO_IDS[numero];
            console.log(`🔄 Admin check: Convertido ${numero} -> ${numeroParaVerificar}`);
        } else {
            // Tentar extrair número base e procurar no ADMINISTRADORES_GLOBAIS
            const numeroBase = numero.split('@')[0];
            const adminEncontrado = ADMINISTRADORES_GLOBAIS.find(admin =>
                admin.startsWith(numeroBase + '@')
            );
            if (adminEncontrado) {
                numeroParaVerificar = adminEncontrado;
                console.log(`🔄 Admin check: Convertido ${numero} -> ${numeroParaVerificar} (por número base)`);
            }
        }
    }

    // Agora verificar cache com o número convertido
    const cached = adminCache.get(numeroParaVerificar);
    if (cached !== undefined && cached !== null) {
        return cached;
    }

    // Calcular e cachear resultado
    const isAdmin = ADMINISTRADORES_GLOBAIS.includes(numeroParaVerificar);
    adminCache.set(numeroParaVerificar, isAdmin);
    // Cachear também o ID original se foi convertido
    if (numeroParaVerificar !== numero) {
        adminCache.set(numero, isAdmin);
    }

    return isAdmin;
}

function isGrupoMonitorado(chatId) {
    return CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
}

function getConfiguracaoGrupo(chatId) {
    // Verificar se existe configuração customizada
    if (sistemaConfigGrupos) {
        const configCustomizada = sistemaConfigGrupos.obterConfig(chatId);
        if (configCustomizada && configCustomizada.tabela) {
            // Usar config customizada, mas manter nome do padrão se existir
            const configPadrao = CONFIGURACAO_GRUPOS[chatId];
            return {
                grupoId: chatId, // ADICIONAR grupoId ao retorno
                nome: configPadrao?.nome || configCustomizada.nome || 'Grupo',
                tabela: configCustomizada.tabela,
                pagamento: configCustomizada.pagamento || configPadrao?.pagamento || ''
            };
        }
    }

    // Usar configuração padrão do código
    const configPadrao = CONFIGURACAO_GRUPOS[chatId];
    if (configPadrao) {
        // Adicionar grupoId ao objeto retornado
        return {
            grupoId: chatId,
            ...configPadrao
        };
    }

    return null;
}

// Função para resolver ID interno (@lid) para número real (@c.us)
function resolverIdReal(participantId, adminsEncontrados) {
    // Se já é @c.us, retorna como está
    if (participantId.endsWith('@c.us')) {
        return participantId;
    }
    
    // Se tem mapeamento conhecido, usa ele
    if (MAPEAMENTO_IDS[participantId]) {
        return MAPEAMENTO_IDS[participantId];
    }
    
    // Se é @lid, tenta encontrar correspondência nos admins
    if (participantId.endsWith('@lid')) {
        // Para agora, retorna o próprio ID para permitir comparação direta
        return participantId;
    }
    
    return participantId;
}

// Função para converter LID para número usando API oficial do wwebjs
async function lidParaNumero(lid) {
    try {
        console.log(`🔍 INICIO: Convertendo LID para número: ${lid}`);
        console.log(`🔍 CLIENTE: Status do cliente: ${client ? 'disponível' : 'não disponível'}`);

        if (!client) {
            console.error(`❌ Cliente WhatsApp não está disponível para conversão LID`);
            return null;
        }

        // Verificar se o cliente está realmente pronto
        try {
            const info = await client.getState();
            console.log(`🔍 ESTADO: Cliente estado: ${info}`);
            if (info !== 'CONNECTED') {
                console.error(`❌ Cliente não está conectado (estado: ${info}) - não é possível converter LID`);
                return null;
            }
        } catch (stateError) {
            console.error(`❌ Erro ao verificar estado do cliente:`, stateError.message);
            return null;
        }

        console.log(`🔍 CHAMANDO: client.getContactById(${lid})`);
        const contato = await client.getContactById(lid);
        console.log(`🔍 CONTATO: Objeto recebido:`, contato ? 'OK' : 'NULL');

        if (!contato) {
            console.error(`❌ Contato não encontrado para LID: ${lid}`);
            return null;
        }

        const numeroReal = contato.number;
        console.log(`✅ LID convertido com sucesso: ${lid} → ${numeroReal}`);
        return numeroReal; // Retorna número no formato internacional (ex: 258841234567)
    } catch (err) {
        console.error(`❌ Erro detalhado ao buscar número para LID ${lid}:`, err.message);
        console.error(`❌ Stack trace:`, err.stack);
        return null;
    }
}


// FUNÇÕES DE VERIFICAÇÃO DE ADMIN DO GRUPO REMOVIDAS
// Agora usa apenas isAdministrador() com ADMINISTRADORES_GLOBAIS

function contemConteudoSuspeito(mensagem) {
    const texto = mensagem.toLowerCase();

    // Detectar apenas URLs reais, não a palavra "link"
    // Regex atualizado para detectar apenas links reais (http://, https://, www., ou domínios completos)
    // Explicação:
    // - https?://...  -> URLs com esquema
    // - www....       -> URLs começando com www
    // - domínio.tld    -> detectar padrões como example.com (lista de TLDs comuns)
    // - encurtadores  -> bit.ly, tinyurl.com, t.me, wa.me, whatsapp.com, telegram.me
    const temLink = /(?:https?:\/\/[\S]+|www\.[\S]+|(?:bit\.ly|tinyurl\.com|t\.me|wa\.me|whatsapp\.com|telegram\.me)\/[\S]+|[a-z0-9\-]+\.(?:com|net|org|io|br|co|xyz|online|info|biz|me|us|edu|gov)(?:[\/\s]|$))/i.test(texto);

    return {
        temLink: MODERACAO_CONFIG.detectarLinks && temLink,
        suspeito: MODERACAO_CONFIG.detectarLinks && temLink
    };
}

async function deletarMensagem(message) {
    try {
        await message.delete(true);
        console.log(`🗑️ Mensagem deletada`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao deletar mensagem:', error);
        return false;
    }
}

async function removerParticipante(chatId, participantId, motivo) {
    try {
        const chat = await client.getChatById(chatId);
        await chat.removeParticipants([participantId]);
        console.log(`🚫 Participante removido: ${participantId} - ${motivo}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao remover participante:', error);
        return false;
    }
}

async function aplicarModeracao(message, motivoDeteccao) {
    const chatId = message.from;
    const authorId = message.author || message.from;
    
    try {
        // Ativar moderação para todos os grupos que estiverem em CONFIGURACAO_GRUPOS.
        // Se o grupo está listado em CONFIGURACAO_GRUPOS a moderação será aplicada independente de entradas conflitantes em MODERACAO_CONFIG.ativado.
        const ativadoExplicit = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId) ||
            (MODERACAO_CONFIG.ativado && MODERACAO_CONFIG.ativado[chatId]);

        if (!ativadoExplicit) return;

        if (MODERACAO_CONFIG.excecoes.includes(authorId) || isAdministrador(authorId)) {
            return;
        }

        console.log(`🚨 MODERAÇÃO: ${motivoDeteccao}`);

        if (MODERACAO_CONFIG.apagarMensagem) {
            await deletarMensagem(message);
        }

        if (MODERACAO_CONFIG.removerUsuario) {
            // Tentar obter informações do contato para menção/nomes
            let mentionId = String(authorId).replace('@c.us', '').replace('@lid', '');
            let nomeExibicao = mentionId;
            try {
                const contato = await client.getContactById(authorId);
                if (contato) {
                    nomeExibicao = contato.pushname || contato.name || contato.number || mentionId;
                }
            } catch (err) {
                // ignora erro de obtenção de contato, usaremos o ID reduzido
            }

            // Enviar aviso ao grupo antes/depois da remoção
            try {
                // VALIDAÇÃO CRÍTICA: Verificar se é um ID válido de usuário
                const ehIDValido = authorId &&
                                  typeof authorId === 'string' &&
                                  (authorId.includes('@c.us') || authorId.includes('@lid')) &&
                                  !authorId.startsWith('SAQUE_BONUS_') &&
                                  !authorId.startsWith('SAQ');

                const aviso = `🚫 @${mentionId} foi removido(a) do grupo por enviar link.`;

                if (ehIDValido) {
                    await client.sendMessage(chatId, aviso, { mentions: [authorId] });
                } else {
                    console.warn(`⚠️ ID inválido para menção de remoção: ${authorId}`);
                    await client.sendMessage(chatId, aviso);
                }
            } catch (errAviso) {
                // Se o envio do aviso falhar, não interromper a remoção
                console.log('⚠️ Não foi possível enviar aviso de remoção:', errAviso.message);
            }

            const removido = await removerParticipante(chatId, authorId, motivoDeteccao);

            if (!removido) {
                try {
                    // VALIDAÇÃO CRÍTICA: Verificar se é um ID válido de usuário
                    const ehIDValido = authorId &&
                                      typeof authorId === 'string' &&
                                      (authorId.includes('@c.us') || authorId.includes('@lid')) &&
                                      !authorId.startsWith('SAQUE_BONUS_') &&
                                      !authorId.startsWith('SAQ');

                    const avisoErro = `⚠️ Não foi possível remover @${mentionId}. Verifique se o bot tem permissões de administrador.`;

                    if (ehIDValido) {
                        await client.sendMessage(chatId, avisoErro, { mentions: [authorId] });
                    } else {
                        console.warn(`⚠️ ID inválido para menção de erro: ${authorId}`);
                        await client.sendMessage(chatId, avisoErro);
                    }
                } catch (err2) {
                    console.log('⚠️ Falha ao notificar sobre remoção mal-sucedida:', err2.message);
                }
            }
        }

    } catch (error) {
        console.error('❌ Erro durante moderação:', error);
    }
}

// === DETECÇÃO DE GRUPOS ===
async function logGrupoInfo(chatId, evento = 'detectado') {
    try {
        const chat = await client.getChatById(chatId);
        const isGrupoMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
        
        console.log(`\n🔍 ═══════════════════════════════════════`);
        console.log(`📋 GRUPO ${evento.toUpperCase()}`);
        console.log(`🔍 ═══════════════════════════════════════`);
        console.log(`📛 Nome: ${chat.name}`);
        console.log(`🆔 ID: ${chatId}`);
        console.log(`👥 Participantes: ${chat.participants ? chat.participants.length : 'N/A'}`);
        console.log(`📊 Monitorado: ${isGrupoMonitorado ? '✅ SIM' : '❌ NÃO'}`);
        console.log(`⏰ Data: ${new Date().toLocaleString('pt-BR')}`);
        
        if (!isGrupoMonitorado) {
            console.log(`\n🔧 PARA ADICIONAR ESTE GRUPO:`);
            console.log(`📝 Copie este código para CONFIGURACAO_GRUPOS:`);
            console.log(`\n'${chatId}': {`);
            console.log(`    nome: '${chat.name}',`);
            console.log(`    tabela: \`SUA_TABELA_AQUI\`,`);
            console.log(`    pagamento: \`SUAS_FORMAS_DE_PAGAMENTO_AQUI\``);
            console.log(`},\n`);
        }
        
        console.log(`🔍 ═══════════════════════════════════════\n`);
        
        return {
            id: chatId,
            nome: chat.name,
            participantes: chat.participants ? chat.participants.length : 0,
            monitorado: isGrupoMonitorado
        };
        
    } catch (error) {
        console.error(`❌ Erro ao obter informações do grupo ${chatId}:`, error);
        return null;
    }
}

// === HISTÓRICO DE COMPRADORES ===

async function carregarHistorico() {
    try {
        const data = await fs.readFile(ARQUIVO_HISTORICO, 'utf8');
        historicoCompradores = JSON.parse(data);
        console.log('📊 Histórico carregado!');
    } catch (error) {
        console.log('📊 Criando novo histórico...');
        historicoCompradores = {};
    }
}

// === SALVAMENTO DE HISTÓRICO OTIMIZADO ===
let salvamentoHistoricoPendente = false;
let timeoutHistorico = null;

async function salvarHistorico() {
    if (salvamentoHistoricoPendente) return;
    salvamentoHistoricoPendente = true;

    try {
        await fs.writeFile(ARQUIVO_HISTORICO, JSON.stringify(historicoCompradores));
    } catch (error) {
        console.error('❌ Erro ao salvar histórico:', error);
    } finally {
        salvamentoHistoricoPendente = false;
    }
}

function agendarSalvamentoHistorico() {
    if (timeoutHistorico) {
        clearTimeout(timeoutHistorico);
    }

    timeoutHistorico = setTimeout(async () => {
        agendarSalvamentoHistorico();
        timeoutHistorico = null;
    }, 3000); // 3 segundos para histórico
}

async function registrarComprador(grupoId, numeroComprador, nomeContato, valorTransferencia) {
    try {
        // Enviar para API MariaDB
        const response = await axios.post('http://localhost:3002/api/compradores', {
            grupo_id: grupoId,
            numero: numeroComprador,
            nome: nomeContato,
            megas: parseInt(valorTransferencia) || 0
        }, {
            timeout: 5000
        });

        if (response.data.success) {
            console.log(`💰 Comprador registrado no MariaDB: ${nomeContato} (${numeroComprador}) - ${valorTransferencia}MB`);
        } else {
            console.error(`❌ Erro ao registrar comprador: ${response.data.error}`);
        }
    } catch (error) {
        console.error(`❌ Erro ao registrar comprador no MariaDB: ${error.message}`);

        // Fallback: salvar no JSON local (backup)
        const agora = new Date();
        const timestamp = agora.toISOString();

        if (!historicoCompradores[grupoId]) {
            historicoCompradores[grupoId] = {
                nomeGrupo: getConfiguracaoGrupo(grupoId)?.nome || 'Grupo Desconhecido',
                compradores: {}
            };
        }

        if (!historicoCompradores[grupoId].compradores[numeroComprador]) {
            historicoCompradores[grupoId].compradores[numeroComprador] = {
                primeiraCompra: timestamp,
                ultimaCompra: timestamp,
                totalCompras: 1,
                nomeContato: nomeContato,
                historico: []
            };
        } else {
            historicoCompradores[grupoId].compradores[numeroComprador].ultimaCompra = timestamp;
            historicoCompradores[grupoId].compradores[numeroComprador].totalCompras++;
            historicoCompradores[grupoId].compradores[numeroComprador].nomeContato = nomeContato;
        }

        historicoCompradores[grupoId].compradores[numeroComprador].historico.push({
            data: timestamp,
            valor: valorTransferencia
        });

        if (historicoCompradores[grupoId].compradores[numeroComprador].historico.length > 10) {
            historicoCompradores[grupoId].compradores[numeroComprador].historico =
                historicoCompradores[grupoId].compradores[numeroComprador].historico.slice(-10);
        }

        agendarSalvamentoHistorico();
        console.log(`💾 Comprador registrado no JSON (fallback): ${nomeContato} (${numeroComprador}) - ${valorTransferencia}MB`);
    }
}

// === FILA DE MENSAGENS ===

// REMOVIDO: Funções de processamento de fila de encaminhamento
// (Sistema movido para outro bot)

// === EVENTOS DO BOT ===

client.on('qr', (qr) => {
    console.log('📱 QR Code gerado - Escaneie o QR Code:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔐 Cliente autenticado com sucesso!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha na autenticação:', msg);
});

client.on('loading_screen', (percent, message) => {
    console.log('⏳ Carregando WhatsApp...', percent + '%', message);
});

client.on('ready', async () => {
    console.log('✅ Bot conectado e pronto!');
    console.log('🧠 IA WhatsApp ativa!');
    console.log('📊 API MariaDB configurado!');
    console.log(`🔗 URL: ${API_PEDIDOS_CONFIG.scriptUrl}`);
    console.log('🤖 Bot Retalho - Lógica simples igual ao Bot Atacado!');

    // Verificar se acabou de reiniciar e notificar grupos
    await verificarPosRestart();

    // Carregar mapeamentos LID salvos
    await carregarMapeamentos();

    // REMOVIDO: Carregamento de registro de mensagens (sistema movido para outro bot)

    // === INICIALIZAR SISTEMA DE RELATÓRIOS ===
    try {
        global.sistemaRelatorios = new SistemaRelatorios(client, API_PEDIDOS_CONFIG, API_PAGAMENTOS_CONFIG);

        // Carregar configurações salvas
        await global.sistemaRelatorios.carregarConfiguracoes();

        // Iniciar agendamento às 22h
        global.sistemaRelatorios.iniciarAgendamento();

        console.log('📊 Sistema de relatórios iniciado!');
        console.log('⏰ Relatórios agendados para 22:00 diariamente');
        console.log('💰 Preço de compra: 12 MT/GB | Revenda: 16-18 MT/GB');
        console.log('📞 Comandos: .config-relatorio .list-relatorios .remove-relatorio .test-relatorio');

    } catch (error) {
        console.error('❌ Erro ao iniciar sistema de relatórios:', error.message);
    }

    // === INICIALIZAR SISTEMA DE RETRY SILENCIOSO ===
    await carregarPagamentosPendentes();
    console.log('🔄 Sistema de Retry Silencioso ATIVADO!');
    
    // === INICIALIZAR SISTEMA DE PACOTES APÓS WhatsApp CONECTAR ===
    if (process.env.SISTEMA_PACOTES_ENABLED === 'true') {
        sistemaPacotes = new SistemaPacotes();
        console.log('📦 Sistema de Pacotes Automáticos ATIVADO');
    } else {
        console.log('📦 Sistema de Pacotes Automáticos DESABILITADO (.env)');
    }
    
    // === INICIALIZAR SISTEMA DE COMPRAS ===
    sistemaCompras = new SistemaCompras();
    console.log('🛒 Sistema de Registro de Compras ATIVADO');

    // === INICIALIZAR SISTEMA DE BÔNUS ===
    sistemaBonus = new SistemaBonus();
    await sistemaBonus.carregarDados();
    console.log('💰 Sistema de Bônus ATIVADO');

    // === INICIALIZAR SISTEMA DE CONFIGURAÇÃO DE GRUPOS ===
    sistemaConfigGrupos = new SistemaConfigGrupos();
    await sistemaConfigGrupos.carregarConfiguracoes();
    console.log('⚙️ Sistema de Configuração de Grupos ATIVADO');

    // Carregar dados de referência (legado - será migrado)
    await carregarDadosReferencia();

    // CORRIGIDO: Sincronizar dados legados com SistemaBonus
    console.log('🔄 Sincronizando dados legados com SistemaBonus...');

    // Sincronizar códigos de referência
    if (Object.keys(codigosReferencia).length > 0) {
        sistemaBonus.codigosReferencia = { ...codigosReferencia };
        console.log(`   ✅ ${Object.keys(codigosReferencia).length} códigos sincronizados`);
    }

    // Sincronizar referências de clientes
    if (Object.keys(referenciasClientes).length > 0) {
        sistemaBonus.referenciasClientes = { ...referenciasClientes };
        console.log(`   ✅ ${Object.keys(referenciasClientes).length} referências sincronizadas`);
    }

    // Sincronizar saldos de bônus (mesclar dados)
    if (Object.keys(bonusSaldos).length > 0) {
        for (const [clienteId, saldoLegado] of Object.entries(bonusSaldos)) {
            const saldoNovo = sistemaBonus.buscarSaldo(clienteId);
            if (!saldoNovo || saldoNovo.saldo === 0) {
                // Se não existe no novo sistema ou está zerado, usar dados legados
                sistemaBonus.bonusSaldos[clienteId] = { ...saldoLegado };
            }
        }
        console.log(`   ✅ ${Object.keys(bonusSaldos).length} saldos mesclados`);
    }

    // Salvar dados sincronizados
    await sistemaBonus.salvarDados();
    console.log('✅ Sincronização concluída e salva!');

    // === CONFIGURAR PREMIAÇÃO DO MELHOR COMPRADOR DO DIA ===
    sistemaCompras.setClient(client);
    sistemaCompras.setSistemaBonus(sistemaBonus);
    sistemaCompras.setGruposAtivos(Object.keys(CONFIGURACAO_GRUPOS));
    sistemaCompras.iniciarAgendamentoPremiacaoDiaria();
    console.log('🏆 Sistema de Premiação do Melhor Comprador ATIVADO (22:00)');

    await carregarHistorico();
    
    console.log('\n🤖 Monitorando grupos:');
    Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
        const config = CONFIGURACAO_GRUPOS[grupoId];
        console.log(`   📋 ${config.nome} (${grupoId})`);
    });
    
    console.log('\n🔧 Comandos admin: .ia .stats .sheets .test_sheets .test_grupo .grupos_status .grupos .grupo_atual .addcomando .comandos .delcomando .addgatilho .gatilhos .delgatilho .test_vision .ranking .rankingdia .rankingsemana .rankingmes .inativos .detetives .semcompra .resetranking .bonus .testreferencia .config-relatorio .list-relatorios .remove-relatorio .test-relatorio');

    // Monitoramento de novos membros DESATIVADO
    console.log('⏸️ Monitoramento automático de novos membros DESATIVADO');
});

// Event group-join DESATIVADO
client.on('group-join', async (notification) => {
    // Sistema de boas-vindas automáticas DESATIVADO - código removido completamente
    console.log('⏸️ Event group-join ignorado - sistema desativado');
    return;
});

// === HANDLERS SEPARADOS POR TIPO DE COMANDO ===
async function handleAdminCommands(message) {
    const autorMensagem = message.author || message.from;
    const comando = message.body.toLowerCase().trim();

    // Comando .souadmin - QUALQUER pessoa pode usar para verificar se é admin
    if (comando === '.souadmin') {
        const isAdmin = isAdministrador(autorMensagem);
        const contato = await message.getContact();
        const nome = contato.pushname || contato.name || 'Você';

        let resposta = `🔍 *VERIFICAÇÃO DE ADMINISTRADOR*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        resposta += `👤 Nome: ${nome}\n`;
        resposta += `📱 ID: ${autorMensagem}\n`;
        resposta += `👑 Admin: ${isAdmin ? '✅ SIM' : '❌ NÃO'}\n\n`;

        if (autorMensagem.includes('@lid')) {
            resposta += `ℹ️ Seu ID é do tipo @lid\n`;
            if (MAPEAMENTO_IDS[autorMensagem]) {
                resposta += `🔄 Mapeado para: ${MAPEAMENTO_IDS[autorMensagem]}\n`;
            } else {
                resposta += `⚠️ Não há mapeamento @lid para seu ID\n`;
            }
        }

        await message.reply(resposta);
        return true;
    }

    const isAdmin = isAdministrador(autorMensagem);
    if (!isAdmin) return false;

    // Comandos administrativos rápidos
    if (comando === '.ia') {
        const statusIA = ia.getStatusDetalhado();
        await message.reply(statusIA);
        return true;
    }

    if (comando === '.queue') {
        const stats = messageQueue.getStats();
        await message.reply(`📊 *QUEUE STATUS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🔄 Fila: ${stats.queueSize}\n⚡ Ativos: ${stats.activeJobs}\n🎯 Processando: ${stats.processing ? 'SIM' : 'NÃO'}`);
        return true;
    }

    if (comando === '.memory') {
        const stats = memoryManager.getStats();
        const memStats = `📊 *MEMORY STATUS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n💾 Memória: ${stats.memory.total}MB\n🗄️ Cache Transações: ${stats.cacheTransacoes}\n👥 Códigos Ref: ${stats.codigosReferencia}\n🎯 Clientes Ref: ${stats.referenciasClientes}\n💰 Bônus: ${stats.bonusSaldos}\n⏳ Pagamentos Pendentes: ${stats.pagamentosPendentes}`;
        await message.reply(memStats);
        return true;
    }

    if (comando === '.pool') {
        let poolStatus = `🔗 *AXIOS STATUS (SIMPLIFICADO)*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        poolStatus += `✅ Axios simplificado ativo\n`;
        poolStatus += `⚡ Timeout: 30s\n`;
        poolStatus += `🔄 Max redirects: 3\n`;
        poolStatus += `📊 Pool complexo removido (seguindo bot1)`;

        await message.reply(poolStatus);
        return true;
    }

    if (comando === '.performance') {
        const queueStats = messageQueue.getStats();
        const usage = process.memoryUsage();
        const memTotal = Math.round(usage.rss / 1024 / 1024);

        let perfStatus = `⚡ *PERFORMANCE STATUS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        perfStatus += `🔒 Admin Cache: ${adminCache.size} entradas\n`;
        perfStatus += `📤 Message Queue: ${queueStats.queueSize} fila, ${queueStats.activeJobs} ativos\n`;
        perfStatus += `💾 Memória: ${memTotal}MB\n`;
        perfStatus += `🔇 Modo Silencioso: ${SILENT_MODE ? 'ATIVO' : 'INATIVO'}\n`;
        perfStatus += `🔗 Conexões: Axios simplificado (bot1 pattern)`;

        await message.reply(perfStatus);
        return true;
    }

    return false; // Comando não foi processado aqui
}

async function handlePurchaseCommands(message) {
    const body = message.body.toLowerCase().trim();

    // Comandos de compra que precisam ir para fila
    if (body.includes('comprar') || body.includes('mb') || body.includes('gb') ||
        body.startsWith('.') || body.includes('referencia') || body.includes('bonus')) {
        return true; // Deve ser processado na fila
    }

    return false;
}

async function processMessage(message) {
    try {
        const isPrivado = !message.from.endsWith('@g.us');
        const autorMensagem = message.author || message.from;
        const isAdmin = isAdministrador(autorMensagem);

        // DEBUG DETALHADO DA MENSAGEM
        if (message.body.startsWith('.addcomando') || message.body.startsWith('.comandos') || message.body.startsWith('.delcomando') ||
            message.body.startsWith('.addgatilho') || message.body.startsWith('.gatilhos') || message.body.startsWith('.delgatilho')) {
            smartLog(LOG_LEVEL.DEBUG, `🔍 DEBUG MENSAGEM ADMIN:`);
            console.log(`   📱 message.from: ${message.from}`);
            console.log(`   👤 message.author: ${message.author}`);
            console.log(`   🆔 autorMensagem: ${autorMensagem}`);
            
            try {
                const contact = await message.getContact();
                console.log(`   📞 Contact info:`, {
                    id: contact.id._serialized,
                    number: contact.number,
                    pushname: contact.pushname,
                    name: contact.name,
                    isMyContact: contact.isMyContact
                });
            } catch (err) {
                console.log(`   ⚠️ Erro ao obter contato: ${err.message}`);
            }
        }
        
        smartLog(LOG_LEVEL.DEBUG, `🔍 Debug: Verificando admin para ${autorMensagem}, resultado: ${isAdmin}`);

        // === COMANDOS ADMINISTRATIVOS ===
        smartLog(LOG_LEVEL.DEBUG, `🔍 Debug final: isAdmin = ${isAdmin}`);

        if (isAdmin) {
            const comando = message.body.toLowerCase().trim();

            if (comando === '.ia') {
                const statusIA = ia.getStatusDetalhado();
                await message.reply(statusIA);
                console.log(`🧠 Comando .ia executado`);
                return;
            }

            // === COMANDO DEBUG MENSAGENS DE SISTEMA ===
            if (comando === '.debug') {
                try {
                    const chat = await client.getChatById(message.from);
                    const mensagens = await chat.fetchMessages({ limit: 20 });

                    let debugInfo = `🔍 *DEBUG MENSAGENS (últimas 20)*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                    mensagens.forEach((msg, index) => {
                        const timestamp = new Date(msg.timestamp * 1000).toLocaleString();
                        debugInfo += `${index + 1}. *Tipo:* ${msg.type}\n`;
                        debugInfo += `   *Timestamp:* ${timestamp}\n`;
                        debugInfo += `   *Author:* ${msg.author || 'Sistema'}\n`;
                        debugInfo += `   *Body:* "${msg.body || 'N/A'}"\n\n`;
                    });

                    await message.reply(debugInfo);
                    console.log(`🔍 Comando .debug executado`);
                } catch (error) {
                    await message.reply(`❌ Erro no debug: ${error.message}`);
                }
                return;
            }

            if (comando === '.retry') {
                const pendenciasAtivas = Object.values(pagamentosPendentes);
                let statusRetry = `🔄 *STATUS RETRY SILENCIOSO*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                if (pendenciasAtivas.length === 0) {
                    statusRetry += `✅ Nenhum pagamento pendente\n`;
                    statusRetry += `⏹️ Timer: ${timerRetryPagamentos ? 'ATIVO' : 'PARADO'}\n`;
                } else {
                    statusRetry += `⏳ Pagamentos pendentes: ${pendenciasAtivas.length}\n\n`;

                    pendenciasAtivas.forEach((pendencia, index) => {
                        const tempoRestante = Math.max(0, Math.floor((pendencia.expira - Date.now()) / 60000));
                        const tempoDecorrido = Math.floor((Date.now() - pendencia.timestamp) / 60000);

                        statusRetry += `${index + 1}. ${pendencia.referencia}\n`;
                        statusRetry += `   💰 Valor: ${pendencia.valorComprovante}MT\n`;
                        statusRetry += `   🔄 Tentativas: ${pendencia.tentativas}/${MAX_RETRY_ATTEMPTS}\n`;
                        statusRetry += `   ⏰ Há ${tempoDecorrido}min (${tempoRestante}min restantes)\n\n`;
                    });

                    statusRetry += `🔄 Timer: ${timerRetryPagamentos ? 'ATIVO' : 'PARADO'}\n`;
                    statusRetry += `⏱️ Próxima verificação: ${RETRY_INTERVAL/1000}s\n`;
                }

                await message.reply(statusRetry);
                console.log(`🔄 Comando .retry executado`);
                return;
            }

            // === COMANDO CANCELAR REFERÊNCIA AUTOMÁTICA ===
            if (comando.startsWith('.cancelar ')) {
                const codigo = comando.replace('.cancelar ', '').trim().toUpperCase();

                if (!codigo) {
                    await message.reply('❌ Use: .cancelar CODIGO\nExemplo: .cancelar ABC123');
                    return;
                }

                // Verificar se o código existe
                const clienteId = codigosReferencia[codigo];
                if (!clienteId) {
                    await message.reply(`❌ Código de referência *${codigo}* não encontrado.`);
                    return;
                }

                const referencia = referenciasClientes[clienteId];
                if (!referencia) {
                    await message.reply(`❌ Dados da referência *${codigo}* não encontrados.`);
                    return;
                }

                // Verificar se quem está cancelando é o convidador
                const autorMensagem = message.author || message.from;
                if (referencia.convidadoPor !== autorMensagem) {
                    await message.reply(`❌ Apenas *${referencia.nomeConvidador}* pode cancelar esta referência.`);
                    return;
                }

                // Verificar se é uma referência automática
                const metodosAutomaticos = ['AUTO_INTELIGENTE', 'AUTO_ANALISE_MENSAGENS'];
                if (!metodosAutomaticos.includes(referencia.metodoDeteccao)) {
                    await message.reply(`❌ Apenas referências criadas automaticamente podem ser canceladas.\nPara referências manuais, contacte o administrador.`);
                    return;
                }

                // Verificar se já teve atividade (compras)
                if (referencia.comprasRealizadas > 0) {
                    await message.reply(`❌ Não é possível cancelar - cliente já realizou ${referencia.comprasRealizadas} compra(s).\nContacte o administrador se necessário.`);
                    return;
                }

                // Cancelar a referência
                delete referenciasClientes[clienteId];
                delete codigosReferencia[codigo];

                const mensagemCancelamento = `✅ *REFERÊNCIA CANCELADA*

🎯 **Código:** ${codigo}
👤 **Cliente:** ${referencia.nomeConvidado}
📅 **Cancelado em:** ${new Date().toLocaleDateString('pt-PT')}

💡 A referência foi removida do sistema.`;

                await message.reply(mensagemCancelamento);
                console.log(`🗑️ Referência automática cancelada: ${codigo} por ${referencia.nomeConvidador}`);
                return;
            }

            if (comando === '.stats') {
                let stats = `📊 *ESTATÍSTICAS*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n`;
                
                Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
                    const config = CONFIGURACAO_GRUPOS[grupoId];
                    const dados = historicoCompradores[grupoId];
                    const totalCompradores = dados ? Object.keys(dados.compradores || {}).length : 0;
                    
                    if (totalCompradores > 0) {
                        stats += `🏢 *${config.nome}*\n`;
                        stats += `👥 ${totalCompradores} compradores\n\n`;
                    }
                });
                
                await message.reply(stats);
                return;
            }

            if (comando === '.bonus_stats') {
                let stats = `🎁 *ESTATÍSTICAS DO SISTEMA DE REFERÊNCIAS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                // Estatísticas gerais
                const totalCodigos = Object.keys(codigosReferencia).length;
                const totalReferencias = Object.keys(referenciasClientes).length;
                const totalUsuariosComBonus = Object.keys(bonusSaldos).length;
                const totalSaques = Object.keys(pedidosSaque).length;
                
                stats += `📊 **RESUMO GERAL:**\n`;
                stats += `   • Códigos gerados: ${totalCodigos}\n`;
                stats += `   • Referências ativas: ${totalReferencias}\n`;
                stats += `   • Usuários com bônus: ${totalUsuariosComBonus}\n`;
                stats += `   • Saques solicitados: ${totalSaques}\n\n`;
                
                // Top convidadores
                const topConvidadores = Object.values(bonusSaldos)
                    .map(dados => ({
                        saldo: dados.saldo,
                        referencias: Object.keys(dados.detalhesReferencias || {}).length,
                        dados: dados
                    }))
                    .sort((a, b) => b.saldo - a.saldo)
                    .slice(0, 5);
                
                if (topConvidadores.length > 0) {
                    stats += `🏆 **TOP 5 CONVIDADORES:**\n`;
                    topConvidadores.forEach((item, index) => {
                        const saldoGB = (item.saldo / 1024).toFixed(2);
                        stats += `   ${index + 1}. ${item.saldo}MB (${saldoGB}GB) - ${item.referencias} referências\n`;
                    });
                    stats += `\n`;
                }
                
                // Estatísticas de compras
                let totalComprasBonus = 0;
                let totalBonusDistribuido = 0;
                
                Object.values(bonusSaldos).forEach(saldo => {
                    if (saldo.detalhesReferencias) {
                        Object.values(saldo.detalhesReferencias).forEach(ref => {
                            totalComprasBonus += ref.compras || 0;
                            totalBonusDistribuido += ref.bonusGanho || 0;
                        });
                    }
                });
                
                stats += `💰 **BÔNUS DISTRIBUÍDOS:**\n`;
                stats += `   • Total de compras que geraram bônus: ${totalComprasBonus}\n`;
                stats += `   • Total de MB distribuídos: ${totalBonusDistribuido}MB\n`;
                stats += `   • Equivalente em GB: ${(totalBonusDistribuido / 1024).toFixed(2)}GB\n\n`;
                
                // Saques pendentes
                const saquesPendentes = Object.values(pedidosSaque).filter(p => p.status === 'pendente');
                if (saquesPendentes.length > 0) {
                    stats += `⏳ **SAQUES PENDENTES:** ${saquesPendentes.length}\n`;
                    const totalPendente = saquesPendentes.reduce((sum, p) => sum + p.quantidade, 0);
                    stats += `   • Valor total: ${totalPendente}MB (${(totalPendente/1024).toFixed(2)}GB)\n\n`;
                }
                
                stats += `📈 **SISTEMA DE REFERÊNCIAS ATIVO E FUNCIONANDO!**`;
                
                await message.reply(stats);
                return;
            }

            // === COMANDOS DO SISTEMA DE PACOTES ===
            if (sistemaPacotes) {

                // .pacote DIAS REF NUMERO - Criar pacote
                if (comando.startsWith('.pacote ')) {
                    try {
                        console.log(`🔧 DEBUG: Comando .pacote detectado!`);
                        console.log(`🔧 DEBUG: sistemaPacotes = ${sistemaPacotes ? 'INICIALIZADO' : 'NULL'}`);
                        console.log(`🔧 DEBUG: SISTEMA_PACOTES_ENABLED = ${process.env.SISTEMA_PACOTES_ENABLED}`);

                        if (!sistemaPacotes) {
                            await message.reply(`❌ *SISTEMA DE PACOTES DESABILITADO*\n\nO sistema de pacotes automáticos não está ativo neste servidor.\n\nVerifique as configurações de ambiente.`);
                            return;
                        }

                        const partes = message.body.trim().split(' ');

                        if (partes.length < 4) {
                            await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato correto:**\n*.pacote DIAS REF NUMERO*\n\n📝 **Exemplos:**\n• *.pacote 3 ABC123 845123456*\n• *.pacote 5 XYZ789 847654321*\n• *.pacote 15 DEF456 841234567*\n\n📦 **Dias disponíveis:** 3, 5, 15, 30\n\n🌍 **Formatos de número aceitos:**\n• 845123456\n• +258 845 123 456\n• 258845123456\n\n⚠️ **IMPORTANTE:**\nEste comando serve APENAS para agendar renovações automáticas.\nVocê deve ter enviado o pacote principal MANUALMENTE antes de usar este comando.\n\n🔄 O sistema agendará renovações diárias de 100MB durante o período especificado.`);
                            return;
                        }

                        const [, diasPacote, referencia, numeroInput] = partes;
                        const numero = normalizarNumeroTelefone(numeroInput);
                        const grupoId = message.from;

                        if (!numero || numero.length !== 9) {
                            await message.reply(`❌ *NÚMERO INVÁLIDO*\n\nAceita formatos:\n• 845123456\n• +258 845 123 456\n• 258845123456`);
                            return;
                        }

                        console.log(`📦 COMANDO PACOTE: Dias=${diasPacote}, Ref=${referencia}, NumeroInput=${numeroInput}, NumeroNormalizado=${numero}`);

                        // Modo manual: não precisa de megas/valor inicial (apenas agenda renovações)
                        // Usar valores simbólicos (não serão enviados, apenas para registro)
                        const megasIniciais = 0; // Não usado em modo manual
                        const valorMTInicial = 0; // Não usado em modo manual

                        const resultado = await sistemaPacotes.processarComprovante(referencia, numero, grupoId, diasPacote, megasIniciais, valorMTInicial, true); // true = modo manual

                        if (resultado.sucesso) {
                            await message.reply(resultado.mensagem);
                        } else {
                            await message.reply(`❌ **ERRO AO CRIAR PACOTE**\n\n⚠️ ${resultado.erro}\n\n💡 **Verificar:**\n• Dias válidos (3, 5, 15, 30)\n• Referência não está duplicada`);
                        }
                    } catch (error) {
                        console.error('❌ Erro no comando .pacote:', error);
                        await message.reply(`❌ **ERRO INTERNO**\n\n⚠️ Não foi possível processar o pacote\n\n📝 Erro: ${error.message}`);
                    }
                    return;
                }
                
                // .pacotes_ativos - Listar clientes com pacotes ativos (do grupo atual)
                if (comando === '.pacotes_ativos') {
                    const lista = sistemaPacotes.listarClientesAtivos(message.from);
                    await message.reply(lista);
                    return;
                }
                
                // .pacotes_stats - Estatísticas do sistema de pacotes
                if (comando === '.pacotes_stats') {
                    const stats = sistemaPacotes.obterEstatisticas();
                    await message.reply(stats);
                    return;
                }

                // .pacotes_todos - Listar pacotes de TODOS os grupos (apenas admins globais)
                if (comando === '.pacotes_todos') {
                    if (!isAdministrador(autorMensagem)) {
                        await message.reply('❌ *Acesso negado!* Apenas administradores globais podem ver pacotes de todos os grupos.');
                        return;
                    }
                    const lista = sistemaPacotes.listarClientesAtivos(null); // null = todos os grupos
                    await message.reply(lista);
                    return;
                }
                
                // .cancelar_pacote NUMERO REF - Cancelar pacote
                if (comando.startsWith('.cancelar_pacote ')) {
                    const partes = message.body.trim().split(' ');
                    
                    if (partes.length < 3) {
                        await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato correto:**\n*.cancelar_pacote NUMERO REFERENCIA*\n\n📝 **Exemplo:**\n• *.cancelar_pacote 845123456 ABC123*`);
                        return;
                    }
                    
                    const [, numero, referencia] = partes;
                    const resultado = sistemaPacotes.cancelarPacote(numero, referencia);
                    await message.reply(resultado);
                    return;
                }

                // .validade NUMERO - Verificar validade do pacote (comando para CLIENTES)
                if (comando.startsWith('.validade ')) {
                    const partes = message.body.trim().split(' ');

                    if (partes.length < 2) {
                        await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato correto:**\n*.validade NUMERO*\n\n📝 **Exemplo:**\n• *.validade 845123456*\n\n💡 Digite seu número para verificar a validade do seu pacote de 100MB diários.\n\n🌍 Aceita formatos: 845123456, +258 845 123 456, 258845123456`);
                        return;
                    }

                    const numeroInput = partes[1];
                    const numero = normalizarNumeroTelefone(numeroInput);

                    if (!numero || numero.length !== 9) {
                        await message.reply(`❌ *NÚMERO INVÁLIDO*\n\nAceita formatos:\n• 845123456\n• +258 845 123 456\n• 258845123456`);
                        return;
                    }

                    const resultado = sistemaPacotes.verificarValidadePacote(numero);
                    
                    await message.reply(resultado);
                    return;
                }
                
                // .sistema_pacotes - Status do sistema
                if (comando === '.sistema_pacotes') {
                    const status = sistemaPacotes.getStatus();
                    let resposta = `📦 *STATUS DO SISTEMA DE PACOTES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                    resposta += `🟢 **Status:** ${status.ativo ? 'ATIVO' : 'INATIVO'}\n`;
                    resposta += `👥 **Clientes ativos:** ${status.clientesAtivos}\n`;
                    resposta += `⏱️ **Verificação:** ${status.intervalVerificacao/60000} min\n`;
                    resposta += `📦 **Tipos disponíveis:** ${status.tiposPacotes.join(', ')}\n`;
                    resposta += `📊 **Histórico:** ${status.historicoSize} registros\n\n`;
                    resposta += `🔧 **Comandos Administrativos:**\n`;
                    resposta += `• *.pacote DIAS REF NUMERO* - Criar pacote\n`;
                    resposta += `• *.pacotes_ativos* - Listar ativos\n`;
                    resposta += `• *.pacotes_stats* - Estatísticas\n`;
                    resposta += `• *.cancelar_pacote NUMERO REF* - Cancelar\n\n`;
                    resposta += `👤 **Comando para Clientes:**\n`;
                    resposta += `• *.validade NUMERO* - Verificar validade do pacote\n\n`;
                    resposta += `⚡ *Sistema funcionando automaticamente!*`;
                    
                    await message.reply(resposta);
                    return;
                }
            }

            // === COMANDOS DO SISTEMA DE COMPRAS ===
            if (sistemaCompras) {
                // .ranking - Mostrar ranking completo de compradores
                if (comando === '.ranking') {
                    try {
                        const ranking = await sistemaCompras.obterRankingCompletoGrupo(message.from);

                        console.log(`📊 DEBUG RANKING: Recebeu ${ranking ? ranking.length : 0} itens`);
                        if (ranking && ranking.length > 0) {
                            console.log(`📊 DEBUG RANKING: Primeiro item:`, JSON.stringify(ranking[0]));
                        }

                        if (!ranking || ranking.length === 0) {
                            await message.reply(`📊 *RANKING DE COMPRADORES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🚫 Nenhum comprador registrado no grupo.`);
                            return;
                        }
                        
                        let mensagem = `📊 *RANKING DE COMPRADORES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        let mentions = [];
                        
                        for (let i = 0; i < ranking.length; i++) {
                            const item = ranking[i];

                            // Validar se o item tem dados válidos
                            if (!item || !item.numero) {
                                console.log(`⚠️ Item inválido no ranking na posição ${i}`);
                                continue;
                            }

                            // COPIAR EXATAMENTE A LÓGICA DAS BOAS-VINDAS - SEM CONVERSÃO
                            const participantId = item.numero; // Usar número exatamente como está salvo

                            // Obter informações do contato
                            try {
                                const contact = await client.getContactById(participantId);

                                // Prioridade: nome salvo > nome do perfil > número
                                const nomeExibicao = contact.name || contact.pushname || item.numero;

                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${item.posicao}º`;
                                const megasFormatados = (item.megas || 0) >= 1024 ?
                                    `${((item.megas || 0)/1024).toFixed(1)}GB` : `${item.megas || 0}MB`;

                                // Formatar o ID para menção (remover @c.us ou @lid)
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');

                                // Usar exatamente o mesmo padrão das boas-vindas
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} no grupo (${item.compras || 0}x)\n`;
                                mensagem += `   📊 Total: ${(item.megasTotal || 0) >= 1024 ? ((item.megasTotal || 0)/1024).toFixed(1)+'GB' : (item.megasTotal || 0)+'MB'}\n\n`;

                                mentions.push(participantId);
                            } catch (error) {
                                // Se não conseguir obter o contato, usar apenas o número com padrão das boas-vindas
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${item.posicao}º`;
                                const megasFormatados = (item.megas || 0) >= 1024 ?
                                    `${((item.megas || 0)/1024).toFixed(1)}GB` : `${item.megas || 0}MB`;

                                // Formatar o ID para menção (remover @c.us ou @lid)
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');

                                // Usar exatamente o mesmo padrão das boas-vindas
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} no grupo (${item.compras || 0}x)\n`;
                                mensagem += `   📊 Total: ${(item.megasTotal || 0) >= 1024 ? ((item.megasTotal || 0)/1024).toFixed(1)+'GB' : (item.megasTotal || 0)+'MB'}\n\n`;

                                mentions.push(participantId);
                            }
                        }

                        mensagem += `🏆 *Total de compradores no grupo: ${ranking.length}*`;

                        // Validar e limpar array de mentions (aceitar @lid e @c.us)
                        const mentionsValidos = mentions.filter(id => {
                            if (!id || typeof id !== 'string') {
                                console.log(`⚠️ Mention inválido (não é string):`, id);
                                return false;
                            }
                            // Aceitar @lid e @c.us, mas não IDs genéricos do sistema
                            if (id.startsWith('SAQUE_BONUS_')) {
                                console.log(`⚠️ Mention ignorado (sistema):`, id);
                                return false;
                            }
                            if (!id.includes('@lid') && !id.includes('@c.us')) {
                                console.log(`⚠️ Mention sem @lid ou @c.us:`, id);
                                return false;
                            }
                            return true;
                        });

                        console.log(`📊 Ranking: ${ranking.length} compradores, ${mentionsValidos.length} mentions válidos`);

                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter ranking:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter o ranking de compradores.\n\n⚠️ Erro: ${error.message}`);
                        return;
                    }
                }

                // .rankingdia - Mostrar ranking do dia
                if (comando === '.rankingdia') {
                    try {
                        await sistemaCompras.atualizarRankingDiarioGrupo(message.from);
                        const top5 = await sistemaCompras.obterTop5CompradoresDia(message.from);
                        const estatisticas = await sistemaCompras.obterEstatisticasDiariasGrupo(message.from);

                        if (!top5 || top5.length === 0) {
                            await message.reply(`🌟 *RANKING DO DIA*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🚫 Nenhuma compra registrada hoje.`);
                            return;
                        }

                        let mensagem = `🌟 *RANKING DO DIA*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        let mentions = [];

                        for (let i = 0; i < top5.length; i++) {
                            const item = top5[i];
                            const participantId = item.numero;

                            try {
                                const contact = await client.getContactById(participantId);
                                const nomeExibicao = contact.name || contact.pushname || item.numero;
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasDia || 0) >= 1024 ?
                                    `${((item.megasDia || 0)/1024).toFixed(1)}GB` : `${item.megasDia || 0}MB`;

                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} hoje (${item.comprasDia || 0}x)\n\n`;
                                mentions.push(participantId);
                            } catch (error) {
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasDia || 0) >= 1024 ?
                                    `${((item.megasDia || 0)/1024).toFixed(1)}GB` : `${item.megasDia || 0}MB`;
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} hoje (${item.comprasDia || 0}x)\n\n`;
                                mentions.push(participantId);
                            }
                        }

                        const totalMegas = estatisticas.totalMegasDia >= 1024 ?
                            `${(estatisticas.totalMegasDia/1024).toFixed(1)}GB` : `${estatisticas.totalMegasDia}MB`;
                        mensagem += `📊 *Total do dia: ${totalMegas} (${estatisticas.totalComprasDia} compras)*`;

                        const mentionsValidos = mentions.filter(id => id && typeof id === 'string' && (id.includes('@lid') || id.includes('@c.us')));
                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter ranking do dia:', error);
                        await message.reply(`❌ Erro ao obter ranking do dia: ${error.message}`);
                        return;
                    }
                }

                // .rankingsemana - Mostrar ranking da semana
                if (comando === '.rankingsemana') {
                    try {
                        await sistemaCompras.atualizarRankingSemanalGrupo(message.from);
                        const top5 = await sistemaCompras.obterTop5CompradoresTodaSemana(message.from);
                        const estatisticas = await sistemaCompras.obterEstatisticasSemanaisGrupo(message.from);

                        if (!top5 || top5.length === 0) {
                            await message.reply(`⭐ *RANKING DA SEMANA*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🚫 Nenhuma compra registrada esta semana.`);
                            return;
                        }

                        let mensagem = `⭐ *RANKING DA SEMANA*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        let mentions = [];

                        for (let i = 0; i < top5.length; i++) {
                            const item = top5[i];
                            const participantId = item.numero;

                            try {
                                const contact = await client.getContactById(participantId);
                                const nomeExibicao = contact.name || contact.pushname || item.numero;
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasSemana || 0) >= 1024 ?
                                    `${((item.megasSemana || 0)/1024).toFixed(1)}GB` : `${item.megasSemana || 0}MB`;

                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} esta semana (${item.comprasSemana || 0}x)\n\n`;
                                mentions.push(participantId);
                            } catch (error) {
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasSemana || 0) >= 1024 ?
                                    `${((item.megasSemana || 0)/1024).toFixed(1)}GB` : `${item.megasSemana || 0}MB`;
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} esta semana (${item.comprasSemana || 0}x)\n\n`;
                                mentions.push(participantId);
                            }
                        }

                        const totalMegas = estatisticas.totalMegasSemana >= 1024 ?
                            `${(estatisticas.totalMegasSemana/1024).toFixed(1)}GB` : `${estatisticas.totalMegasSemana}MB`;
                        mensagem += `📊 *Total da semana: ${totalMegas} (${estatisticas.totalComprasSemana} compras)*`;

                        const mentionsValidos = mentions.filter(id => id && typeof id === 'string' && (id.includes('@lid') || id.includes('@c.us')));
                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter ranking da semana:', error);
                        await message.reply(`❌ Erro ao obter ranking da semana: ${error.message}`);
                        return;
                    }
                }

                // .rankingmes - Mostrar ranking do mês
                if (comando === '.rankingmes') {
                    try {
                        await sistemaCompras.atualizarRankingMensalGrupo(message.from);
                        const top5 = await sistemaCompras.obterTop5CompradoresMes(message.from);
                        const estatisticas = await sistemaCompras.obterEstatisticasMensaisGrupo(message.from);

                        if (!top5 || top5.length === 0) {
                            await message.reply(`📆 *RANKING DO MÊS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🚫 Nenhuma compra registrada este mês.`);
                            return;
                        }

                        let mensagem = `📆 *RANKING DO MÊS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        let mentions = [];

                        for (let i = 0; i < top5.length; i++) {
                            const item = top5[i];
                            const participantId = item.numero;

                            try {
                                const contact = await client.getContactById(participantId);
                                const nomeExibicao = contact.name || contact.pushname || item.numero;
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasMes || 0) >= 1024 ?
                                    `${((item.megasMes || 0)/1024).toFixed(1)}GB` : `${item.megasMes || 0}MB`;

                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} este mês (${item.comprasMes || 0}x)\n\n`;
                                mentions.push(participantId);
                            } catch (error) {
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`;
                                const megasFormatados = (item.megasMes || 0) >= 1024 ?
                                    `${((item.megasMes || 0)/1024).toFixed(1)}GB` : `${item.megasMes || 0}MB`;
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${posicaoEmoji} @${mentionId}\n`;
                                mensagem += `   💾 ${megasFormatados} este mês (${item.comprasMes || 0}x)\n\n`;
                                mentions.push(participantId);
                            }
                        }

                        const totalMegas = estatisticas.totalMegasMes >= 1024 ?
                            `${(estatisticas.totalMegasMes/1024).toFixed(1)}GB` : `${estatisticas.totalMegasMes}MB`;
                        mensagem += `📊 *Total do mês: ${totalMegas} (${estatisticas.totalComprasMes} compras)*`;

                        const mentionsValidos = mentions.filter(id => id && typeof id === 'string' && (id.includes('@lid') || id.includes('@c.us')));
                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter ranking do mês:', error);
                        await message.reply(`❌ Erro ao obter ranking do mês: ${error.message}`);
                        return;
                    }
                }

                // .inativos - Mostrar membros do grupo que NUNCA compraram
                if (comando === '.inativos') {
                    try {
                        // Obter todos os participantes do grupo
                        const chat = await message.getChat();
                        const participantes = chat.participants || [];

                        console.log(`👥 Total de participantes no grupo: ${participantes.length}`);

                        // Obter lista de compradores do grupo
                        const compradores = await sistemaCompras.obterRankingCompletoGrupo(message.from);

                        // Criar Set com todos os IDs possíveis dos compradores
                        const compradoresIdsSet = new Set();

                        for (const comprador of compradores) {
                            const idComprador = comprador.numero;
                            compradoresIdsSet.add(idComprador);

                            // Tentar obter o contato para descobrir outros IDs
                            try {
                                const contact = await client.getContactById(idComprador);

                                // Adicionar o ID principal do contato
                                if (contact.id && contact.id._serialized) {
                                    compradoresIdsSet.add(contact.id._serialized);
                                }

                                // Adicionar número do usuário se disponível
                                if (contact.id && contact.id.user) {
                                    compradoresIdsSet.add(`${contact.id.user}@c.us`);
                                }

                                // Se o ID salvo é @lid, verificar mapeamento
                                if (idComprador.includes('@lid') && MAPEAMENTO_IDS[idComprador]) {
                                    compradoresIdsSet.add(MAPEAMENTO_IDS[idComprador]);
                                }
                            } catch (error) {
                                // Continuar mesmo se não conseguir obter o contato
                                console.log(`⚠️ Não foi possível obter contato para: ${idComprador}`);
                            }
                        }

                        console.log(`🛒 Total de compradores: ${compradores.length}`);
                        console.log(`🛒 Total de IDs únicos (todos os formatos): ${compradoresIdsSet.size}`);

                        // Obter IDs dos participantes
                        const participantesIds = participantes.map(p => p.id._serialized);
                        console.log(`👥 Total de participantes: ${participantesIds.length}`);

                        // Filtrar participantes que nunca compraram
                        const nuncaCompraram = [];

                        for (const participanteId of participantesIds) {
                            // Verificar se está no Set de compradores
                            if (compradoresIdsSet.has(participanteId)) {
                                console.log(`✅ ${participanteId} É COMPRADOR - filtrado`);
                                continue;
                            }

                            // Verificar também pelo número base
                            const numeroBase = participanteId.split('@')[0];
                            const temNumeroBase = Array.from(compradoresIdsSet).some(id => id.startsWith(numeroBase));

                            if (temNumeroBase) {
                                console.log(`✅ ${participanteId} (base: ${numeroBase}) É COMPRADOR - filtrado`);
                                continue;
                            }

                            // Não é comprador
                            nuncaCompraram.push(participanteId);
                        }

                        console.log(`🚫 Membros que nunca compraram: ${nuncaCompraram.length}`);

                        if (nuncaCompraram.length === 0) {
                            await message.reply(`🎉 *MEMBROS QUE NUNCA COMPRARAM*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ Todos os membros do grupo já fizeram pelo menos uma compra!`);
                            return;
                        }

                        let mensagem = `🚫 *MEMBROS QUE NUNCA COMPRARAM*\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
                        mensagem += `📊 Total: ${nuncaCompraram.length} membros\n\n`;
                        let mentions = [];

                        // Limitar a 50 membros para não sobrecarregar a mensagem
                        const limite = Math.min(nuncaCompraram.length, 50);

                        for (let i = 0; i < limite; i++) {
                            const participantId = nuncaCompraram[i];

                            // Validar ID
                            if (!participantId || participantId.startsWith('SAQUE_BONUS_')) {
                                continue;
                            }

                            try {
                                const contact = await client.getContactById(participantId);
                                const nomeExibicao = contact.name || contact.pushname || 'Membro';

                                // Formatar o ID para menção (remover @c.us ou @lid)
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');

                                mensagem += `${i + 1}. @${mentionId}\n`;

                                mentions.push(participantId);
                            } catch (error) {
                                // Se não conseguir obter o contato, adicionar mesmo assim
                                const mentionId = String(participantId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${i + 1}. @${mentionId}\n`;
                                mentions.push(participantId);
                            }
                        }

                        if (nuncaCompraram.length > limite) {
                            mensagem += `\n... e mais ${nuncaCompraram.length - limite} membros\n`;
                        }

                        mensagem += `\n🚫 *Total: ${nuncaCompraram.length} membros que nunca compraram*`;

                        // Validar mentions (aceitar @lid e @c.us)
                        const mentionsValidos = mentions.filter(id => {
                            if (!id || typeof id !== 'string') return false;
                            if (id.startsWith('SAQUE_BONUS_')) return false;
                            if (!id.includes('@lid') && !id.includes('@c.us')) return false;
                            return true;
                        });

                        console.log(`🚫 Inativos: ${nuncaCompraram.length} membros, ${mentionsValidos.length} mentions válidos`);

                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter inativos:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter a lista de inativos.\n\n⚠️ Erro: ${error.message}`);
                        return;
                    }
                }

                // .detetives - Mostrar membros que NUNCA mandaram mensagem no grupo
                if (comando === '.detetives') {
                    try {
                        // Obter todos os participantes do grupo
                        const chat = await message.getChat();
                        const participantes = chat.participants || [];

                        console.log(`👥 Total de participantes no grupo: ${participantes.length}`);

                        // REMOVIDO: Sistema de registro de mensagens (movido para outro bot)

                        // Filtrar participantes que nunca mandaram mensagem
                        // NOTA: Agora retorna todos os participantes (sem filtro de mensagens)
                        const nuncaMandaram = [];

                        // REMOVIDO: Verificação de registro de mensagens
                        // Comando .espioes agora está desabilitado (sistema movido para outro bot)

                        await message.reply(`⚠️ *COMANDO DESABILITADO*\n\nO sistema de registro de mensagens foi movido para outro bot.\nUse o bot de monitoramento para esta funcionalidade.`);
                        return;

                        console.log(`🕵️ Membros que nunca mandaram mensagem: ${nuncaMandaram.length}`);

                        if (nuncaMandaram.length === 0) {
                            await message.reply(`🎉 *MEMBROS ESPIÕES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ Não há espiões! Todos os membros do grupo já mandaram pelo menos uma mensagem!`);
                            return;
                        }

                        let mensagem = `🕵️ *MEMBROS ESPIÕES*\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
                        mensagem += `📊 Total: ${nuncaMandaram.length} membros\n\n`;
                        let mentions = [];

                        // Limitar a 50 membros para não sobrecarregar a mensagem
                        const limite = Math.min(nuncaMandaram.length, 50);

                        for (let i = 0; i < limite; i++) {
                            const participanteId = nuncaMandaram[i];

                            // Validar ID
                            if (!participanteId || participanteId.startsWith('SAQUE_BONUS_')) {
                                continue;
                            }

                            try {
                                const contact = await client.getContactById(participanteId);
                                const nomeExibicao = contact.name || contact.pushname || 'Membro';

                                // Formatar o ID para menção (remover @c.us ou @lid)
                                const mentionId = String(participanteId).replace('@c.us', '').replace('@lid', '');

                                mensagem += `${i + 1}. @${mentionId}\n`;

                                mentions.push(participanteId);
                            } catch (error) {
                                // Se não conseguir obter o contato, adicionar mesmo assim
                                const mentionId = String(participanteId).replace('@c.us', '').replace('@lid', '');
                                mensagem += `${i + 1}. @${mentionId}\n`;
                                mentions.push(participanteId);
                            }
                        }

                        if (nuncaMandaram.length > limite) {
                            mensagem += `\n... e mais ${nuncaMandaram.length - limite} espiões\n`;
                        }

                        mensagem += `\n🕵️ *Total de espiões: ${nuncaMandaram.length}*`;

                        // Validar mentions (aceitar @lid e @c.us)
                        const mentionsValidos = mentions.filter(id => {
                            if (!id || typeof id !== 'string') return false;
                            if (id.startsWith('SAQUE_BONUS_')) return false;
                            if (!id.includes('@lid') && !id.includes('@c.us')) return false;
                            return true;
                        });

                        console.log(`🕵️ Detetives: ${nuncaMandaram.length} membros, ${mentionsValidos.length} mentions válidos`);

                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter detetives:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter a lista de detetives.\n\n⚠️ Erro: ${error.message}`);
                        return;
                    }
                }

                // .semcompra - Mostrar usuários que nunca compraram
                if (comando === '.semcompra') {
                    try {
                        const semCompra = await sistemaCompras.obterSemCompra();
                        
                        if (semCompra.length === 0) {
                            await message.reply(`🆕 *USUÁRIOS SEM COMPRAS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n✨ Todos os usuários registrados já fizeram pelo menos uma compra!`);
                            return;
                        }
                        
                        let mensagem = `🆕 *USUÁRIOS SEM COMPRAS*\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
                        mensagem += `👥 Nunca fizeram compras\n\n`;
                        let mentions = [];
                        
                        for (let i = 0; i < Math.min(semCompra.length, 30); i++) {
                            const item = semCompra[i];
                            // COPIAR EXATAMENTE A LÓGICA DAS BOAS-VINDAS - SEM CONVERSÃO
                            const participantId = item.numero; // Usar número exatamente como está salvo

                            // Obter informações do contato
                            try {
                                const contact = await client.getContactById(participantId);
                                
                                // Prioridade: nome salvo > nome do perfil > número
                                const nomeExibicao = contact.name || contact.pushname || item.numero;
                                const numeroLimpo = contact.id.user; // Número sem @ e sem +
                                
                                mensagem += `👤 @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   📅 Registrado: ${new Date(item.primeiraCompra).toLocaleDateString('pt-BR')}\n`;
                                mensagem += `   💰 Compras: ${item.totalCompras} (${item.megasTotal}MB)\n\n`;
                                
                                mentions.push(participantId);
                            } catch (error) {
                                // Se não conseguir obter o contato, usar apenas o número
                                mensagem += `👤 @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   📅 Registrado: ${new Date(item.primeiraCompra).toLocaleDateString('pt-BR')}\n`;
                                mensagem += `   💰 Compras: ${item.totalCompras} (${item.megasTotal}MB)\n\n`;
                                
                                mentions.push(participantId);
                            }
                        }
                        
                        if (semCompra.length > 30) {
                            mensagem += `... e mais ${semCompra.length - 30} usuários sem compras\n\n`;
                        }
                        
                        mensagem += `🆕 *Total sem compras: ${semCompra.length}*\n\n`;
                        mensagem += `💡 *Dica:* Considere campanhas de incentivo para estes usuários!`;

                        // VALIDAÇÃO CRÍTICA: Filtrar IDs inválidos do array mentions
                        const mentionsValidos = mentions.filter(id => {
                            return id &&
                                   typeof id === 'string' &&
                                   (id.includes('@c.us') || id.includes('@lid')) &&
                                   !id.startsWith('SAQUE_BONUS_') &&
                                   !id.startsWith('SAQ');
                        });

                        console.log(`📊 Sem compra: ${mentions.length} mentions, ${mentionsValidos.length} válidos`);
                        await client.sendMessage(message.from, mensagem, { mentions: mentionsValidos });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter sem compra:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter a lista de usuários sem compras.\n\n⚠️ Erro: ${error.message}`);
                        return;
                    }
                }

                // .resetranking - Comando removido (ranking diário/semanal desabilitado)
                if (comando === '.resetranking') {
                    await message.reply(`❌ *COMANDO DESABILITADO*\n\nO sistema de ranking diário/semanal foi removido.\nApenas o ranking geral está ativo.`);
                    return;
                }

                // .mapear LID NUMERO - Mapear manualmente LID para número real
                if (comando.startsWith('.mapear ')) {
                    const partes = message.body.trim().split(' ');
                    if (partes.length !== 3) {
                        await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato:**\n*.mapear LID_CODE NUMERO*\n\n📝 **Exemplo:**\n*.mapear 76991768342659@lid 258870818180@c.us*\n\n💡 **Dica:** Use este comando quando souber que um LID específico corresponde a um número real.`);
                        return;
                    }

                    const [, lidCode, numeroReal] = partes;

                    // Validar formatos
                    if (!lidCode.endsWith('@lid')) {
                        await message.reply(`❌ *LID INVÁLIDO*\n\nO LID deve terminar com '@lid'\n\n📝 **Exemplo:** 76991768342659@lid`);
                        return;
                    }

                    if (!numeroReal.endsWith('@c.us')) {
                        await message.reply(`❌ *NÚMERO INVÁLIDO*\n\nO número deve terminar com '@c.us'\n\n📝 **Exemplo:** 258870818180@c.us`);
                        return;
                    }

                    const sucesso = await adicionarMapeamento(lidCode, numeroReal);
                    if (sucesso) {
                        await message.reply(`✅ *MAPEAMENTO ADICIONADO*\n\n🔗 ${lidCode}\n↓\n📱 ${numeroReal}\n\n💾 Salvo no arquivo de mapeamentos.`);
                    } else {
                        await message.reply(`⚠️ *MAPEAMENTO JÁ EXISTE*\n\nEste LID já está mapeado para:\n📱 ${MAPEAMENTO_IDS[lidCode] || 'Desconhecido'}`);
                    }
                    return;
                }

                // .mapeamentos - Listar todos os mapeamentos conhecidos
                if (comando === '.mapeamentos') {
                    let mensagem = `📋 *MAPEAMENTOS LID CONHECIDOS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                    const mapeamentosValidos = Object.entries(MAPEAMENTO_IDS).filter(([lid, numero]) => numero && numero !== null);

                    if (mapeamentosValidos.length === 0) {
                        mensagem += `❌ Nenhum mapeamento encontrado`;
                    } else {
                        mapeamentosValidos.forEach(([lid, numero], index) => {
                            mensagem += `${index + 1}. ${lid}\n   → ${numero}\n\n`;
                        });
                        mensagem += `📊 *Total: ${mapeamentosValidos.length} mapeamentos*`;
                    }

                    await message.reply(mensagem);
                    return;
                }

                // .testreferencia - Testar sistema de referência automática (ADMIN APENAS)
                if (comando === '.testreferencia') {
                    if (!isAdmin) {
                        await message.reply('❌ Apenas administradores podem usar este comando!');
                        return;
                    }

                    try {
                        await message.reply('🧪 *TESTE DE REFERÊNCIA AUTOMÁTICA*\n\nTestando criação de referência automática...');

                        // Simular criação de referência automática usando o admin como convidador e um ID fictício como convidado
                        const convidadorTest = autorMensagem;
                        const convidadoTest = '258000000000@c.us'; // ID fictício para teste
                        const grupoTest = message.from;

                        setTimeout(async () => {
                            try {
                                const resultado = await criarReferenciaAutomatica(convidadorTest, convidadoTest, grupoTest);

                                if (resultado) {
                                    await message.reply(
                                        `✅ *TESTE DE REFERÊNCIA - SUCESSO!*\n\n` +
                                        `🎯 **Resultado do teste:**\n` +
                                        `👤 Convidador: ${await obterNomeContato(convidadorTest)}\n` +
                                        `👥 Convidado: ${convidadoTest.replace('@c.us', '')}\n` +
                                        `🔗 Código gerado: ${resultado.codigo}\n` +
                                        `🤖 Sistema: ${resultado.automatico ? 'Automático' : 'Manual'}\n\n` +
                                        `📋 **Status:**\n` +
                                        `✅ Referência criada com sucesso\n` +
                                        `✅ Notificação enviada\n` +
                                        `✅ Dados salvos\n\n` +
                                        `💡 *Sistema de referência automática está funcionando!*`
                                    );
                                } else {
                                    await message.reply(
                                        `❌ *TESTE DE REFERÊNCIA - FALHOU!*\n\n` +
                                        `⚠️ A criação de referência automática falhou.\n` +
                                        `📝 Verifique os logs para mais detalhes.`
                                    );
                                }
                            } catch (error) {
                                await message.reply(
                                    `❌ *ERRO NO TESTE DE REFERÊNCIA*\n\n` +
                                    `🚨 Erro: ${error.message}\n\n` +
                                    `📝 Verifique a implementação da função criarReferenciaAutomatica`
                                );
                            }
                        }, 1000);

                    } catch (error) {
                        console.error('❌ Erro no comando .testreferencia:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível executar o teste\n\n📝 Erro: ${error.message}`);
                    }
                    return;
                }
                
                // .bonus NUMERO QUANTIDADE - Dar bônus manual (ADMIN APENAS)
                if (comando.startsWith('.bonus ')) {
                    try {
                        console.log(`\n🎁 === COMANDO .BONUS DETECTADO ===`);
                        console.log(`🔍 Autor: ${autorMensagem}`);
                        console.log(`📝 Comando completo: "${comando}"`);

                        // Verificar permissão de admin usando a lista global
                        console.log(`🔑 Verificando permissão de admin para: ${autorMensagem}`);

                        if (!isAdministrador(autorMensagem)) {
                            console.log(`❌ Admin NÃO autorizado: ${autorMensagem}`);
                            return; // Falha silenciosa para segurança
                        }

                        console.log(`✅ Admin AUTORIZADO`);

                        const parametros = comando.split(' ');
                        console.log(`📊 Parâmetros: ${JSON.stringify(parametros)}`);

                        if (parametros.length < 3) {
                            console.log(`❌ Parâmetros insuficientes (${parametros.length})`);
                            await message.reply(`❌ *FORMATO INCORRETO*\n\n✅ Use: *.bonus @usuario QUANTIDADE* ou *.bonus NUMERO QUANTIDADE*\nExemplos:\n• *.bonus @258123456789 500MB*\n• *.bonus 258123456789 500MB*`);
                            return;
                        }

                        let numeroDestino = parametros[1];
                        const quantidadeStr = parametros[2].toUpperCase();
                        console.log(`📱 Número destino: ${numeroDestino}`);
                        console.log(`💎 Quantidade: ${quantidadeStr}`);

                        // USAR O MESMO PADRÃO DO SISTEMA DE COMPRAS
                        // O sistema de compras usa: message.author (ID que vem direto do WhatsApp)
                        // Para bônus admin, usamos: mentionedIds[0] (ID da pessoa mencionada)
                        let idParaSalvar = null;

                        // Verificar se é menção ou número direto
                        if (numeroDestino.startsWith('@')) {
                            console.log(`🔍 Detectada menção (@)`);
                            if (message.mentionedIds && message.mentionedIds.length > 0) {
                                const mencaoId = message.mentionedIds[0];
                                console.log(`📱 ID da menção inicial: ${mencaoId}`);

                                // BUSCAR O PARTICIPANTE REAL NO GRUPO
                                try {
                                    const chat = await message.getChat();
                                    if (chat.isGroup && chat.participants) {
                                        console.log(`🔍 Buscando participante real no grupo (${chat.participants.length} participantes)...`);

                                        // Extrair últimos 9 dígitos do número mencionado
                                        const numeroMencionado = mencaoId.replace('@c.us', '').replace('@lid', '');
                                        const ultimos9 = numeroMencionado.slice(-9);
                                        console.log(`🔍 Buscando por últimos 9 dígitos: ${ultimos9}`);

                                        // Buscar TODOS os participantes que correspondem (pode haver @c.us E @lid)
                                        const participantesEncontrados = [];
                                        chat.participants.forEach(p => {
                                            const pNumero = p.id._serialized.replace('@c.us', '').replace('@lid', '');
                                            const pUltimos9 = pNumero.slice(-9);
                                            if (pUltimos9 === ultimos9 && ultimos9.length === 9) {
                                                participantesEncontrados.push(p.id._serialized);
                                            }
                                        });

                                        console.log(`📋 Participantes encontrados (${participantesEncontrados.length}): ${participantesEncontrados.join(', ')}`);

                                        if (participantesEncontrados.length > 0) {
                                            // Priorizar @lid sobre @c.us (ID real do WhatsApp)
                                            const idLid = participantesEncontrados.find(id => id.includes('@lid'));
                                            idParaSalvar = idLid || participantesEncontrados[0];
                                            console.log(`✅ USANDO ID: ${idParaSalvar} ${idLid ? '(@lid prioritário)' : ''}`);
                                        } else {
                                            idParaSalvar = mencaoId;
                                            console.log(`⚠️ Participante não encontrado, usando ID da menção: ${idParaSalvar}`);
                                        }
                                    } else {
                                        idParaSalvar = mencaoId;
                                        console.log(`⚠️ Não é grupo, usando ID da menção: ${idParaSalvar}`);
                                    }
                                } catch (error) {
                                    console.error(`❌ Erro ao buscar participante:`, error);
                                    idParaSalvar = mencaoId;
                                    console.log(`⚠️ Usando ID da menção por erro: ${idParaSalvar}`);
                                }

                                // Extrair número para exibição
                                numeroDestino = idParaSalvar.replace('@c.us', '').replace('@lid', '');
                                console.log(`📱 Número extraído para exibição: ${numeroDestino}`);
                            } else {
                                console.log(`⚠️ Nenhuma menção encontrada, usando número após @`);
                                const numeroMencao = numeroDestino.substring(1);
                                numeroDestino = numeroMencao;
                            }
                        }

                        // Se não veio de menção, validar o número
                        if (!idParaSalvar) {
                            console.log(`🔎 Validando número: "${numeroDestino}"`);
                            console.log(`   - Tem 9 dígitos? ${/^\d{9}$/.test(numeroDestino)}`);
                            console.log(`   - Tem 12 dígitos? ${/^\d{12}$/.test(numeroDestino)}`);
                            console.log(`   - É ID @lid? ${/^\d+$/.test(numeroDestino)}`);

                            // Validar número - aceitar 9 dígitos, 12 dígitos ou IDs @lid (15 dígitos)
                            if (!/^\d{9,15}$/.test(numeroDestino)) {
                                console.log(`❌ Número INVÁLIDO: ${numeroDestino}`);
                                await message.reply(`❌ *NÚMERO INVÁLIDO*\n\n✅ Use formato:\n• *.bonus @usuario 500MB* (com menção)\n• *.bonus @848715208 500MB* (9 dígitos)\n• *.bonus @258848715208 500MB* (12 dígitos)\n• *.bonus 848715208 500MB* (número direto)`);
                                return;
                            }

                            console.log(`✅ Número válido (${numeroDestino.length} dígitos)`);

                            // Converter para formato completo se necessário (apenas para números de 9 dígitos)
                            if (numeroDestino.length === 9) {
                                numeroDestino = '258' + numeroDestino;
                                console.log(`🔄 Convertido para 12 dígitos: ${numeroDestino}`);
                            }

                            // Criar ID @c.us para números digitados
                            idParaSalvar = `${numeroDestino}@c.us`;
                        }

                        // Converter quantidade para MB
                        let quantidadeMB;
                        if (quantidadeStr.endsWith('GB')) {
                            const gb = parseFloat(quantidadeStr.replace('GB', ''));
                            console.log(`💎 Convertendo GB: ${gb}GB = ${gb * 1024}MB`);
                            if (isNaN(gb) || gb <= 0) {
                                console.log(`❌ GB inválido: ${quantidadeStr}`);
                                await message.reply(`❌ Quantidade inválida: *${quantidadeStr}*`);
                                return;
                            }
                            quantidadeMB = Math.round(gb * 1024);
                        } else if (quantidadeStr.endsWith('MB')) {
                            quantidadeMB = parseInt(quantidadeStr.replace('MB', ''));
                            console.log(`💎 Usando MB diretamente: ${quantidadeMB}MB`);
                            if (isNaN(quantidadeMB) || quantidadeMB <= 0) {
                                console.log(`❌ MB inválido: ${quantidadeStr}`);
                                await message.reply(`❌ Quantidade inválida: *${quantidadeStr}*`);
                                return;
                            }
                        } else {
                            console.log(`❌ Formato desconhecido: ${quantidadeStr}`);
                            await message.reply(`❌ *FORMATO INVÁLIDO*\n\n✅ Use: MB ou GB\nExemplos: 500MB, 1.5GB, 2GB`);
                            return;
                        }

                        console.log(`✅ Quantidade final: ${quantidadeMB}MB`);
                        console.log(`🎯 ID para salvar bônus: ${idParaSalvar}`);

                        // Inicializar saldo se necessário (IGUAL ao sistema de bônus de referência)
                        if (!bonusSaldos[idParaSalvar]) {
                            console.log(`🆕 Criando novo registro de bônus para ${idParaSalvar}`);
                            bonusSaldos[idParaSalvar] = {
                                saldo: 0,
                                detalhesReferencias: {},
                                historicoSaques: [],
                                totalReferencias: 0,
                                bonusAdmin: []
                            };
                        } else {
                            console.log(`✅ Registro existente encontrado para ${idParaSalvar} (saldo: ${bonusSaldos[idParaSalvar].saldo}MB)`);
                        }

                        // === ADICIONAR BÔNUS USANDO SISTEMABONUS (IGUAL AO SISTEMA DE REFERÊNCIA) ===
                        console.log(`💰 Adicionando ${quantidadeMB}MB ao beneficiário...`);

                        let saldoAnterior = 0;
                        let novoSaldo = 0;

                        // Usar sistemaBonus se disponível (método robusto)
                        if (sistemaBonus) {
                            console.log(`✅ Usando SistemaBonus (método robusto)`);

                            await sistemaBonus.atualizarSaldo(idParaSalvar, (saldoObj) => {
                                saldoAnterior = saldoObj.saldo;
                                saldoObj.saldo += quantidadeMB;

                                // Registrar histórico de bônus admin
                                if (!saldoObj.bonusAdmin) {
                                    saldoObj.bonusAdmin = [];
                                }

                                saldoObj.bonusAdmin.push({
                                    quantidade: quantidadeMB,
                                    data: new Date().toISOString(),
                                    admin: autorMensagem,
                                    motivo: 'Bônus administrativo'
                                });

                                novoSaldo = saldoObj.saldo;
                            });

                            console.log(`💰 Saldo atualizado: ${saldoAnterior}MB → ${novoSaldo}MB (+${quantidadeMB}MB)`);
                            console.log(`✅ Dados salvos automaticamente pelo SistemaBonus`);

                        } else {
                            // Fallback para método antigo
                            console.log(`⚠️ SistemaBonus não disponível, usando método antigo`);

                            saldoAnterior = bonusSaldos[idParaSalvar].saldo;
                            bonusSaldos[idParaSalvar].saldo += quantidadeMB;

                            // Registrar histórico de bônus admin
                            if (!bonusSaldos[idParaSalvar].bonusAdmin) {
                                bonusSaldos[idParaSalvar].bonusAdmin = [];
                            }

                            bonusSaldos[idParaSalvar].bonusAdmin.push({
                                quantidade: quantidadeMB,
                                data: new Date().toISOString(),
                                admin: autorMensagem,
                                motivo: 'Bônus administrativo'
                            });

                            novoSaldo = bonusSaldos[idParaSalvar].saldo;

                            console.log(`💰 Saldo atualizado: ${saldoAnterior}MB → ${novoSaldo}MB (+${quantidadeMB}MB)`);

                            // Salvar dados IMEDIATAMENTE
                            console.log(`💾 Salvando dados de bônus imediatamente...`);
                            try {
                                await salvarDadosReferencia();
                                console.log(`✅ Dados de bônus salvos com sucesso!`);
                            } catch (erroSalvamento) {
                                console.error(`❌ ERRO CRÍTICO ao salvar bônus:`, erroSalvamento);
                            }
                        }

                        const quantidadeFormatada = quantidadeMB >= 1024 ? `${(quantidadeMB/1024).toFixed(2)}GB` : `${quantidadeMB}MB`;
                        const novoSaldoFormatado = novoSaldo >= 1024 ? `${(novoSaldo/1024).toFixed(2)}GB` : `${novoSaldo}MB`;

                        console.log(`🎁 ADMIN BONUS CONCEDIDO: ${autorMensagem} → ${numeroDestino} (+${quantidadeFormatada})`);

                        // Notificar o usuário que recebeu o bônus (USANDO EXATAMENTE O PADRÃO DAS CONFIRMAÇÕES DE COMPRA)
                        const mensagemBonus = `🎁 *BÔNUS ADMINISTRATIVO!*\n\n` +
                            `💎 @NOME_PLACEHOLDER, recebeste *${quantidadeFormatada}* de bônus!\n\n` +
                            `👨‍💼 *Ofertado por:* Administrador\n` +
                            `💰 *Novo saldo:* ${novoSaldoFormatado}\n\n` +
                            `${novoSaldo >= 1024 ? '🚀 *Já podes sacar!* Use: *.sacar*' : '💡 *Continua a acumular para sacar!*'}`;

                        try {
                            // VALIDAÇÃO CRÍTICA: Verificar se é um ID válido de usuário
                            const ehIDValido = idParaSalvar &&
                                              typeof idParaSalvar === 'string' &&
                                              (idParaSalvar.includes('@c.us') || idParaSalvar.includes('@lid')) &&
                                              !idParaSalvar.startsWith('SAQUE_BONUS_') &&
                                              !idParaSalvar.startsWith('SAQ');

                            if (!ehIDValido) {
                                console.warn(`⚠️ ID inválido para menção: ${idParaSalvar}`);
                                // Usar fallback sem menção
                                throw new Error('ID inválido para menção');
                            }

                            // SEGUIR PADRÃO DO RANKING (linha 3635-3657)
                            const mentionId = String(idParaSalvar).replace('@c.us', '').replace('@lid', '');

                            // Mensagem usa @mentionId (apenas o número)
                            const mensagemFinal = mensagemBonus.replace('@NOME_PLACEHOLDER', `@${mentionId}`);

                            // Array mentions recebe o ID completo (com @c.us ou @lid)
                            await client.sendMessage(message.from, mensagemFinal, {
                                mentions: [idParaSalvar]
                            });
                        } catch (notificationError) {
                            console.error('❌ Erro ao enviar notificação de bônus admin:', notificationError);
                            // Fallback: enviar sem menção
                            const mentionId = numeroDestino;
                            const mensagemFallback = mensagemBonus.replace('@NOME_PLACEHOLDER', mentionId);
                            await message.reply(mensagemFallback);
                        }

                        await message.reply(
                            `✅ *BÔNUS ADMINISTRATIVO CONCEDIDO*\n\n` +
                            `👤 Beneficiário: ${numeroDestino}\n` +
                            `🎁 Bônus concedido: ${quantidadeFormatada}\n` +
                            `💰 Novo saldo: ${novoSaldoFormatado}\n` +
                            `👑 Concedido por: Administrador\n` +
                            `📅 Data: ${new Date().toLocaleString('pt-BR')}\n\n` +
                            `💡 *O usuário foi notificado automaticamente*`
                        );
                        
                        return;
                    } catch (error) {
                        console.error('❌ Erro no comando .bonus:', error);
                        await message.reply(`❌ *ERRO INTERNO*\n\n⚠️ Não foi possível conceder bônus\n\n📝 Erro: ${error.message}`);
                        return;
                    }
                }

                // === COMANDOS DE RELATÓRIOS ANTIGOS (DESATIVADOS - USAR NOVOS ABAIXO) ===

                // COMANDOS ANTIGOS REMOVIDOS - Usar novos comandos mais abaixo (linha ~4405+)
                // Os novos comandos suportam:
                // - Preço de revenda personalizado por grupo (16-18 MT/GB)
                // - Cálculo automático de lucro
                // - Configuração mais simples (sem precisar do GRUPO_ID)
            }

            // === COMANDOS GOOGLE SHEETS ===
            if (comando === '.test_sheets') {
                console.log(`🧪 Testando API MariaDB...`);
                
                const resultado = await enviarParaGoogleSheets('TEST123', '99', '842223344', 'test_group', 'Teste Admin', 'TestUser');
                
                if (resultado.sucesso) {
                    await message.reply(`✅ *API MariaDB funcionando!*\n\n📊 URL: ${API_PEDIDOS_CONFIG.scriptUrl}\n📝 Row: ${resultado.row}\n🎉 Dados enviados com sucesso!`);
                } else {
                    await message.reply(`❌ *API MariaDB com problema!*\n\n📊 URL: ${API_PEDIDOS_CONFIG.scriptUrl}\n⚠️ Erro: ${resultado.erro}\n\n🔧 *Verifique:*\n• Script publicado corretamente\n• Permissões do API MariaDB\n• Internet funcionando`);
                }
                return;
            }

            if (comando === '.test_vision') {
                const visionStatus = ia.googleVisionEnabled;
                let resposta = `🔍 *TESTE GOOGLE VISION*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n`;
                
                if (visionStatus) {
                    resposta += `✅ **Google Vision: ATIVO**\n`;
                    resposta += `🔧 **Configuração:**\n`;
                    resposta += `   • Timeout: ${ia.googleVisionTimeout}ms\n`;
                    resposta += `   • Fallback: GPT-4 Vision\n\n`;
                    resposta += `📝 **Para testar:**\n`;
                    resposta += `1. Envie uma imagem de comprovante\n`;
                    resposta += `2. Verifique nos logs qual método foi usado\n`;
                    resposta += `3. Google Vision será tentado primeiro\n`;
                    resposta += `4. GPT-4 Vision como fallback\n\n`;
                    resposta += `📊 **Vantagens do método híbrido:**\n`;
                    resposta += `   ✅ Maior precisão OCR\n`;
                    resposta += `   ✅ Menor custo\n`;
                    resposta += `   ✅ Mais rápido\n`;
                    resposta += `   ✅ Sistema redundante`;
                } else {
                    resposta += `❌ **Google Vision: DESABILITADO**\n\n`;
                    resposta += `🔧 **Para ativar:**\n`;
                    resposta += `1. Configure GOOGLE_APPLICATION_CREDENTIALS no .env\n`;
                    resposta += `2. Ou configure GOOGLE_VISION_API_KEY\n`;
                    resposta += `3. Defina GOOGLE_VISION_ENABLED=true\n\n`;
                    resposta += `🧠 **Atualmente usando:**\n`;
                    resposta += `   • GPT-4 Vision apenas\n`;
                    resposta += `   • Funciona normalmente\n`;
                    resposta += `   • Sem redundância`;
                }
                
                await message.reply(resposta);
                return;
            }

            // === COMANDO PARA ADICIONAR COMANDOS CUSTOMIZADOS ===
            if (message.body.startsWith('.addcomando ')) {
                const comandoParsado = parsearComandoCustomizado(message.body);
                
                if (!comandoParsado) {
                    await message.reply(`❌ *Sintaxe incorreta!*\n\n✅ *Sintaxe correta:*\n\`.addcomando Nome do Comando(Sua resposta aqui)\`\n\n📝 *Exemplos:*\n\`.addcomando horário(Funcionamos de 8h às 18h)\`\n\`.addcomando promoção mb(Promoção especial hoje!)\`\n\`.addcomando como comprar(Envie o valor que deseja)\`\n\n⚠️ *Importante:*\n• Aceita múltiplas palavras\n• Aceita caracteres especiais (ç, á, õ, etc)\n• Resposta entre parênteses\n• Pode usar quebras de linha`);
                    return;
                }
                
                try {
                    await adicionarComandoCustomizado(
                        message.from,
                        comandoParsado.nome,
                        comandoParsado.resposta,
                        message.author || message.from
                    );
                    
                    await message.reply(`✅ *Comando criado com sucesso!*\n\n🔧 **Comando:** \`${comandoParsado.nome}\`\n📝 **Resposta:** ${comandoParsado.resposta.substring(0, 100)}${comandoParsado.resposta.length > 100 ? '...' : ''}\n\n💡 **Para usar:** Digite apenas \`${comandoParsado.nome}\``);
                    console.log(`✅ Admin ${message.author || message.from} criou comando '${comandoParsado.nome}' no grupo ${message.from}`);
                } catch (error) {
                    await message.reply(`❌ **Erro ao criar comando**\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao adicionar comando customizado:', error);
                }
                return;
            }

            // === COMANDO PARA LISTAR COMANDOS CUSTOMIZADOS ===
            if (comando === '.comandos') {
                const grupoId = message.from;
                const comandosGrupo = comandosCustomizados[grupoId];
                
                if (!comandosGrupo || Object.keys(comandosGrupo).length === 0) {
                    await message.reply('📋 *Nenhum comando customizado criado ainda*\n\n💡 **Para criar:** `.addcomando nome do comando(resposta)`');
                    return;
                }
                
                let listaComandos = '📋 *COMANDOS CUSTOMIZADOS*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n';
                
                Object.keys(comandosGrupo).forEach(nome => {
                    const cmd = comandosGrupo[nome];
                    const preview = cmd.resposta.length > 50 ? 
                        cmd.resposta.substring(0, 50) + '...' : 
                        cmd.resposta;
                    
                    listaComandos += `🔧 **${nome}**\n📝 ${preview}\n\n`;
                });
                
                listaComandos += `📊 **Total:** ${Object.keys(comandosGrupo).length} comando(s)`;
                
                await message.reply(listaComandos);
                return;
            }

            // === COMANDO PARA REMOVER COMANDOS CUSTOMIZADOS ===
            if (message.body.startsWith('.delcomando ')) {
                const nomeComando = message.body.replace('.delcomando ', '').trim().toLowerCase();

                if (!nomeComando) {
                    await message.reply(`❌ *Nome do comando é obrigatório!*\n\n✅ *Sintaxe:* \`.delcomando nomecomando\`\n\n📝 *Para ver comandos:* \`.comandos\``);
                    return;
                }

                try {
                    const removido = await removerComandoCustomizado(message.from, nomeComando);

                    if (removido) {
                        await message.reply(`✅ *Comando removido!*\n\n🗑️ **Comando:** \`${nomeComando}\`\n\n📝 **Para ver restantes:** \`.comandos\``);
                        console.log(`✅ Admin ${message.author || message.from} removeu comando '${nomeComando}' do grupo ${message.from}`);
                    } else {
                        await message.reply(`❌ *Comando não encontrado!*\n\n🔍 **Comando:** \`${nomeComando}\`\n📝 **Ver comandos:** \`.comandos\``);
                    }
                } catch (error) {
                    await message.reply(`❌ **Erro ao remover comando**\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao remover comando customizado:', error);
                }
                return;
            }

            // === COMANDO PARA ADICIONAR GATILHOS AUTOMÁTICOS ===
            if (message.body.startsWith('.addgatilho ')) {
                const gatilhoParsado = parsearGatilhoAutomatico(message.body);

                if (!gatilhoParsado) {
                    await message.reply(`❌ *Sintaxe incorreta!*\n\n✅ *Sintaxe correta:*\n\`.addgatilho Início da mensagem(Resposta automática)\`\n\n📝 *Exemplos:*\n\`.addgatilho posso(Sim, como posso ajudar?)\`\n\`.addgatilho oi(Olá! Bem-vindo ao nosso grupo!)\`\n\`.addgatilho bom dia(Bom dia! Como posso te ajudar hoje?)\`\n\n⚠️ *Importante:*\n• Responde quando a mensagem COMEÇA com o texto\n• Aceita múltiplas palavras e caracteres especiais\n• Não diferencia maiúsculas/minúsculas`);
                    return;
                }

                try {
                    await adicionarGatilhoAutomatico(
                        message.from,
                        gatilhoParsado.gatilho,
                        gatilhoParsado.resposta,
                        message.author || message.from
                    );

                    await message.reply(`✅ *Gatilho criado com sucesso!*\n\n🎯 **Gatilho:** \`${gatilhoParsado.gatilho}\`\n📝 **Resposta:** ${gatilhoParsado.resposta.substring(0, 100)}${gatilhoParsado.resposta.length > 100 ? '...' : ''}\n\n💡 **Funcionamento:** Quando uma mensagem começar com "${gatilhoParsado.gatilho}", responderá automaticamente`);
                    console.log(`✅ Admin ${message.author || message.from} criou gatilho '${gatilhoParsado.gatilho}' no grupo ${message.from}`);
                } catch (error) {
                    await message.reply(`❌ **Erro ao criar gatilho**\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao adicionar gatilho automático:', error);
                }
                return;
            }

            // === COMANDO PARA LISTAR GATILHOS AUTOMÁTICOS ===
            if (comando === '.gatilhos') {
                const grupoId = message.from;
                const gatilhosGrupo = gatilhosAutomaticos[grupoId];

                if (!gatilhosGrupo || Object.keys(gatilhosGrupo).length === 0) {
                    await message.reply('🎯 *Nenhum gatilho automático criado ainda*\n\n💡 **Para criar:** `.addgatilho texto inicial(resposta)`');
                    return;
                }

                let listaGatilhos = '🎯 *GATILHOS AUTOMÁTICOS*\n━━━━━━━━\n\n';

                Object.keys(gatilhosGrupo).forEach(gatilho => {
                    const g = gatilhosGrupo[gatilho];
                    const preview = g.resposta.length > 50 ?
                        g.resposta.substring(0, 50) + '...' :
                        g.resposta;

                    listaGatilhos += `🔔 **"${gatilho}"**\n📝 ${preview}\n\n`;
                });

                listaGatilhos += `📊 **Total:** ${Object.keys(gatilhosGrupo).length} gatilho(s)`;

                await message.reply(listaGatilhos);
                return;
            }

            // === COMANDO PARA REMOVER GATILHOS AUTOMÁTICOS ===
            if (message.body.startsWith('.delgatilho ')) {
                const nomeGatilho = message.body.replace('.delgatilho ', '').trim().toLowerCase();

                if (!nomeGatilho) {
                    await message.reply(`❌ *Texto do gatilho é obrigatório!*\n\n✅ *Sintaxe:* \`.delgatilho texto inicial\`\n\n📝 *Para ver gatilhos:* \`.gatilhos\``);
                    return;
                }

                try {
                    const removido = await removerGatilhoAutomatico(message.from, nomeGatilho);

                    if (removido) {
                        await message.reply(`✅ *Gatilho removido!*\n\n🗑️ **Gatilho:** \`${nomeGatilho}\`\n\n📝 **Para ver restantes:** \`.gatilhos\``);
                        console.log(`✅ Admin ${message.author || message.from} removeu gatilho '${nomeGatilho}' do grupo ${message.from}`);
                    } else {
                        await message.reply(`❌ *Gatilho não encontrado!*\n\n🔍 **Gatilho:** \`${nomeGatilho}\`\n📝 **Ver gatilhos:** \`.gatilhos\``);
                    }
                } catch (error) {
                    await message.reply(`❌ **Erro ao remover gatilho**\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao remover gatilho automático:', error);
                }
                return;
            }

            // === COMANDO PARA CONFIGURAR NÚMERO DE RELATÓRIO ===
            if (message.body.startsWith('.config-relatorio ')) {
                console.log(`\n======= DEBUG CONFIG-RELATORIO =======`);
                console.log(`📥 Mensagem completa: "${message.body}"`);

                const textoSemComando = message.body.replace('.config-relatorio ', '');
                console.log(`📝 Texto sem comando: "${textoSemComando}"`);

                const args = textoSemComando.trim().split(/\s+/);
                console.log(`📋 Args array:`, args);
                console.log(`📋 Args[0]: "${args[0]}" (type: ${typeof args[0]})`);
                console.log(`📋 Args[1]: "${args[1]}" (type: ${typeof args[1]})`);

                const numeroInput = args[0];
                const precoRevenda = args[1] ? parseFloat(args[1]) : 16;

                console.log(`\n🔍 VALIDAÇÕES:`);
                console.log(`  numeroInput = "${numeroInput}"`);
                console.log(`  length = ${numeroInput ? numeroInput.length : 0}`);
                console.log(`  precoRevenda = ${precoRevenda}`);
                console.log(`  startsWith('258') = ${numeroInput ? numeroInput.startsWith('258') : false}`);

                // Validar formato do número (deve começar com 258 e ter 12 dígitos)
                const numeroLimpo = numeroInput ? numeroInput.trim() : '';
                const apenasDigitos = /^\d+$/.test(numeroLimpo);

                console.log(`  numeroLimpo = "${numeroLimpo}"`);
                console.log(`  apenasDigitos = ${apenasDigitos}`);
                console.log(`  numeroLimpo.length = ${numeroLimpo.length}`);
                console.log(`  numeroLimpo.startsWith('258') = ${numeroLimpo.startsWith('258')}`);

                console.log(`\n✅ CHECKS:`);
                console.log(`  !numeroLimpo = ${!numeroLimpo}`);
                console.log(`  !numeroLimpo.startsWith('258') = ${!numeroLimpo.startsWith('258')}`);
                console.log(`  numeroLimpo.length !== 12 = ${numeroLimpo.length !== 12}`);
                console.log(`  !apenasDigitos = ${!apenasDigitos}`);
                console.log(`======================================\n`);

                if (!numeroLimpo || !numeroLimpo.startsWith('258') || numeroLimpo.length !== 12 || !apenasDigitos) {
                    let motivoErro = [];
                    if (!numeroLimpo) motivoErro.push('número vazio');
                    if (numeroLimpo && !numeroLimpo.startsWith('258')) motivoErro.push('não começa com 258');
                    if (numeroLimpo && numeroLimpo.length !== 12) motivoErro.push(`tem ${numeroLimpo.length} dígitos (esperado: 12)`);
                    if (numeroLimpo && !apenasDigitos) motivoErro.push('contém caracteres não numéricos');

                    await message.reply(`❌ *Número inválido!*\n\n🔍 *Motivo:* ${motivoErro.join(', ')}\n\n✅ *Formato correto:* 258XXXXXXXXX PREÇO\n\n📝 *Exemplos:*\n\`.config-relatorio 258847123456 17\`\n\`.config-relatorio 258852118624 16\`\n\n📊 *Debug info:*\nSeu número: "${numeroInput}"\nLength: ${numeroInput ? numeroInput.length : 0}\nApenas dígitos: ${apenasDigitos}`);
                    return;
                }

                // Validar preço de revenda (16-18 MT/GB)
                if (isNaN(precoRevenda) || precoRevenda < 16 || precoRevenda > 18) {
                    await message.reply(`❌ *Preço inválido!*\n\n✅ O preço deve estar entre 16 e 18 MT/GB\n\n📝 *Exemplo:* \`.config-relatorio 258847123456 17\`\n\n📊 *Seu preço:* ${precoRevenda}`);
                    return;
                }

                // Validar se o número existe no mapeamento
                if (!global.sistemaRelatorios.validarNumeroNoMapeamento(numeroLimpo, MAPEAMENTO_IDS)) {
                    await message.reply(`❌ *Número não encontrado no mapeamento!*\n\n⚠️ O número ${numeroLimpo} não está registrado no sistema.\n\n💡 Apenas números mapeados podem receber relatórios.`);
                    return;
                }

                try {
                    const chat = await message.getChat();
                    const grupoNome = chat.name || 'Grupo';
                    const grupoId = message.from;

                    await global.sistemaRelatorios.configurarNumeroRelatorio(grupoId, numeroLimpo, grupoNome, precoRevenda);

                    await message.reply(`✅ *Relatórios configurados com sucesso!*\n\n📊 **Grupo:** ${grupoNome}\n📱 **Número:** ${numeroInput}\n\n🕙 Relatórios diários serão enviados às 22:00\n\n💬 Uma mensagem de confirmação com detalhes foi enviada para o número configurado.`);

                    console.log(`✅ Admin configurou relatórios do grupo ${grupoNome} para ${numeroInput} - Preço: ${precoRevenda} MT/GB`);
                } catch (error) {
                    await message.reply(`❌ *Erro ao configurar relatórios*\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao configurar relatórios:', error);
                }
                return;
            }

            // === COMANDO PARA LISTAR CONFIGURAÇÕES DE RELATÓRIO ===
            if (comando === '.list-relatorios') {
                const grupoId = message.from;
                const numeroConfigurado = global.sistemaRelatorios.numerosRelatorio[grupoId];

                if (!numeroConfigurado) {
                    await message.reply(`📋 *Relatórios não configurados*\n\n⚠️ Este grupo ainda não tem número configurado para receber relatórios.\n\n💡 **Para configurar:**\n\`.config-relatorio 258XXXXXXXXX PREÇO\`\n\n📝 **Exemplo:**\n\`.config-relatorio 258847123456 17\``);
                    return;
                }

                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';
                const precoRevenda = global.sistemaRelatorios.precosRevenda[grupoId] || 16;
                const lucro = precoRevenda - 12;

                let resposta = `📊 *CONFIGURAÇÃO DE RELATÓRIOS*\n\n`;
                resposta += `👥 **Grupo:** ${grupoNome}\n`;
                resposta += `📱 **Número:** ${numeroConfigurado}\n`;
                resposta += `🕙 **Horário:** Diário às 22:00\n\n`;
                resposta += `💸 **PREÇOS:**\n`;
                resposta += `• Compra: 12 MT/GB\n`;
                resposta += `• Revenda: ${precoRevenda} MT/GB\n`;
                resposta += `• Lucro: ${lucro} MT/GB\n\n`;
                resposta += `✅ Relatórios ativos`;

                await message.reply(resposta);
                return;
            }

            // === COMANDO PARA REMOVER CONFIGURAÇÃO DE RELATÓRIO ===
            if (comando === '.remove-relatorio') {
                const grupoId = message.from;
                const numeroConfigurado = global.sistemaRelatorios.numerosRelatorio[grupoId];

                if (!numeroConfigurado) {
                    await message.reply(`❌ *Nenhuma configuração encontrada*\n\n⚠️ Este grupo não possui relatórios configurados.`);
                    return;
                }

                try {
                    await global.sistemaRelatorios.removerNumeroRelatorio(grupoId);

                    await message.reply(`✅ *Configuração removida!*\n\n📱 **Número removido:** ${numeroConfigurado}\n\n⚠️ Este grupo não receberá mais relatórios automáticos.`);

                    console.log(`✅ Admin removeu configuração de relatórios do grupo ${grupoId}`);
                } catch (error) {
                    await message.reply(`❌ *Erro ao remover configuração*\n\nTente novamente ou contacte o desenvolvedor.`);
                    console.error('❌ Erro ao remover configuração de relatórios:', error);
                }
                return;
            }

            // === COMANDO PARA TESTAR RELATÓRIO ===
            if (comando === '.test-relatorio') {
                const grupoId = message.from;
                const numeroConfigurado = global.sistemaRelatorios.numerosRelatorio[grupoId];

                if (!numeroConfigurado) {
                    await message.reply(`❌ *Relatórios não configurados*\n\n⚠️ Configure primeiro usando:\n\`.config-relatorio 258XXXXXXXXX\``);
                    return;
                }

                try {
                    await message.reply(`🧪 *Gerando relatório de teste...*\n\n⏳ Aguarde alguns segundos...`);

                    const chat = await message.getChat();
                    const grupoNome = chat.name || 'Grupo';

                    await global.sistemaRelatorios.gerarRelatorioGrupo(grupoId, grupoNome);

                    await message.reply(`✅ *Relatório enviado!*\n\n📱 Verifique o número ${numeroConfigurado}`);

                    console.log(`✅ Admin solicitou teste de relatório para grupo ${grupoNome}`);
                } catch (error) {
                    await message.reply(`❌ *Erro ao gerar relatório*\n\n${error.message}`);
                    console.error('❌ Erro ao gerar relatório de teste:', error);
                }
                return;
            }

            // === COMANDO PARA ADICIONAR NOVO GRUPO AO SISTEMA ===
            if (comando === '.configurar') {
                const grupoId = message.from;
                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';
                const autorId = message.author || message.from;

                // VERIFICAR SE É ADMINISTRADOR GLOBAL
                const ehAdminGlobal = ADMINISTRADORES_GLOBAIS.includes(autorId);

                if (!ehAdminGlobal) {
                    await message.reply(
                        `🔒 *ACESSO NEGADO*\n\n` +
                        `⚠️ Apenas **administradores globais** podem adicionar grupos ao sistema.\n\n` +
                        `📞 Solicite a um administrador do sistema.`
                    );
                    console.log(`🚫 ${autorId} tentou usar .configurar sem permissão global`);
                    return;
                }

                // VERIFICAR SE GRUPO JÁ ESTÁ CONFIGURADO
                const grupoJaConfigurado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupoId);

                if (grupoJaConfigurado) {
                    await message.reply(
                        `ℹ️ *GRUPO JÁ CONFIGURADO*\n\n` +
                        `✅ Este grupo já está cadastrado no sistema.\n\n` +
                        `📊 **Nome:** ${grupoNome}\n` +
                        `🆔 **ID:** \`${grupoId}\`\n\n` +
                        `💡 **Para alterar configurações:**\n` +
                        `• \`.config-tabela\` - Alterar tabela de preços\n` +
                        `• \`.config-pagamento\` - Alterar formas de pagamento\n` +
                        `• \`.ver-config\` - Ver configuração atual`
                    );
                    return;
                }

                try {
                    // ADICIONAR GRUPO AO SISTEMA
                    CONFIGURACAO_GRUPOS[grupoId] = {
                        nome: grupoNome,
                        tabela: `📋 *TABELA DE PREÇOS*\n\n⚠️ Configure a tabela usando o comando \`.config-tabela\``,
                        pagamento: `💳 *FORMAS DE PAGAMENTO*\n\n⚠️ Configure o pagamento usando o comando \`.config-pagamento\``
                    };

                    // Salvar também no sistema de configuração
                    await sistemaConfigGrupos.atualizarTabela(
                        grupoId,
                        `📋 *TABELA DE PREÇOS*\n\n⚠️ Configure a tabela usando o comando \`.config-tabela\``,
                        autorId,
                        grupoNome
                    );

                    await message.reply(
                        `✅ *GRUPO ADICIONADO AO SISTEMA!*\n\n` +
                        `🎉 O grupo foi cadastrado com sucesso!\n\n` +
                        `📊 **Grupo:** ${grupoNome}\n` +
                        `🆔 **ID:** \`${grupoId}\`\n` +
                        `👤 **Adicionado por:** Admin Global\n` +
                        `⏰ **Data:** ${new Date().toLocaleString('pt-BR')}\n\n` +
                        `📝 **PRÓXIMOS PASSOS:**\n\n` +
                        `1️⃣ Configure a tabela de preços:\n` +
                        `   \`.config-tabela\`\n` +
                        `   \`[Cole sua tabela aqui]\`\n\n` +
                        `2️⃣ Configure as formas de pagamento:\n` +
                        `   \`.config-pagamento\`\n` +
                        `   \`[Cole informações de pagamento]\`\n\n` +
                        `3️⃣ Verifique a configuração:\n` +
                        `   \`.ver-config\`\n\n` +
                        `💡 **Dica:** Prepare suas tabelas em um arquivo de texto antes de colar!`
                    );

                    console.log(`✅ NOVO GRUPO ADICIONADO: ${grupoNome} (${grupoId}) por admin global ${autorId}`);

                } catch (error) {
                    await message.reply(`❌ *Erro ao adicionar grupo:* ${error.message}`);
                    console.error('❌ Erro ao adicionar grupo:', error);
                }

                return;
            }

            // === COMANDO PARA CONFIGURAR TABELA DE PREÇOS ===
            if (message.body.startsWith('.config-tabela ')) {
                const grupoId = message.from;
                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';
                const autorId = message.author || message.from;

                // VERIFICAR SE É ADMINISTRADOR GLOBAL
                const ehAdminGlobal = ADMINISTRADORES_GLOBAIS.includes(autorId);

                if (!ehAdminGlobal) {
                    await message.reply(
                        `🔒 *ACESSO NEGADO*\n\n` +
                        `⚠️ Apenas **administradores globais** podem alterar configurações.\n\n` +
                        `📞 Solicite a um administrador do sistema.`
                    );
                    console.log(`🚫 ${autorId} tentou usar .config-tabela sem permissão global`);
                    return;
                }

                // VERIFICAR SE GRUPO ESTÁ CONFIGURADO
                const grupoConfigurado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupoId);

                if (!grupoConfigurado) {
                    await message.reply(
                        `❌ *GRUPO NÃO CONFIGURADO*\n\n` +
                        `⚠️ Este grupo ainda não está cadastrado no sistema.\n\n` +
                        `📝 **ID do grupo:** \`${grupoId}\`\n` +
                        `📊 **Nome:** ${grupoNome}\n\n` +
                        `💡 **Para adicionar:** Entre em contato com o desenvolvedor para adicionar este grupo ao código.`
                    );
                    console.log(`⚠️ Tentativa de configurar grupo não cadastrado: ${grupoNome} (${grupoId})`);
                    return;
                }

                // Extrair tabela (tudo após ".config-tabela ")
                const novaTabela = message.body.substring(15).trim();

                console.log(`📝 Admin global ${autorId} solicitou atualização de tabela para grupo ${grupoNome}`);
                console.log(`📏 Tamanho da tabela: ${novaTabela.length} caracteres`);

                try {
                    await message.reply('⏳ *Atualizando tabela...*');

                    // Atualizar tabela (passar nome do grupo também)
                    const resultado = await sistemaConfigGrupos.atualizarTabela(
                        grupoId,
                        novaTabela,
                        autorId,
                        grupoNome
                    );

                    if (resultado.sucesso) {
                        // Recarregar configuração mesclada
                        const configMesclada = sistemaConfigGrupos.mesclarComConfigPadrao(CONFIGURACAO_GRUPOS);
                        Object.assign(CONFIGURACAO_GRUPOS, configMesclada);

                        await message.reply(
                            `✅ *TABELA ATUALIZADA COM SUCESSO!*\n\n` +
                            `📊 **Grupo:** ${grupoNome}\n` +
                            `📦 **Pacotes encontrados:** ${resultado.precosCont}\n` +
                            `⏰ **Atualizado em:** ${new Date().toLocaleString('pt-BR')}\n\n` +
                            `💡 **Para visualizar:** Digite "tabela"\n` +
                            `🔄 **Para restaurar:** Use \`.restaurar-tabela\``
                        );

                        console.log(`✅ Tabela do grupo ${grupoNome} atualizada por admin global ${autorId}`);
                    } else {
                        await message.reply(
                            `❌ *ERRO AO ATUALIZAR TABELA*\n\n` +
                            `⚠️ ${resultado.erro}\n\n` +
                            `💡 **Formato correto:**\n` +
                            `\`.config-tabela\n` +
                            `TABELA DE MEGAS\n` +
                            `1GB = 17MT\n` +
                            `2GB = 34MT\`\n\n` +
                            `📝 **Dica:** Copie a tabela formatada e cole após o comando`
                        );
                    }
                } catch (error) {
                    await message.reply(`❌ *Erro inesperado:* ${error.message}`);
                    console.error('❌ Erro ao configurar tabela:', error);
                }

                return;
            }

            // === COMANDO PARA CONFIGURAR FORMAS DE PAGAMENTO ===
            if (message.body.startsWith('.config-pagamento ')) {
                const grupoId = message.from;
                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';
                const autorId = message.author || message.from;

                // VERIFICAR SE É ADMINISTRADOR GLOBAL
                const ehAdminGlobal = ADMINISTRADORES_GLOBAIS.includes(autorId);

                if (!ehAdminGlobal) {
                    await message.reply(
                        `🔒 *ACESSO NEGADO*\n\n` +
                        `⚠️ Apenas **administradores globais** podem alterar configurações.\n\n` +
                        `📞 Solicite a um administrador do sistema.`
                    );
                    console.log(`🚫 ${autorId} tentou usar .config-pagamento sem permissão global`);
                    return;
                }

                // VERIFICAR SE GRUPO ESTÁ CONFIGURADO
                const grupoConfigurado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupoId);

                if (!grupoConfigurado) {
                    await message.reply(
                        `❌ *GRUPO NÃO CONFIGURADO*\n\n` +
                        `⚠️ Este grupo ainda não está cadastrado no sistema.\n\n` +
                        `📝 Configure primeiro com \`.config-tabela\``
                    );
                    return;
                }

                const novoPagamento = message.body.substring(19).trim();

                try {
                    await message.reply('⏳ *Atualizando formas de pagamento...*');

                    const resultado = await sistemaConfigGrupos.atualizarPagamento(
                        grupoId,
                        novoPagamento,
                        autorId
                    );

                    if (resultado.sucesso) {
                        // Recarregar configuração
                        const configMesclada = sistemaConfigGrupos.mesclarComConfigPadrao(CONFIGURACAO_GRUPOS);
                        Object.assign(CONFIGURACAO_GRUPOS, configMesclada);

                        await message.reply(
                            `✅ *FORMAS DE PAGAMENTO ATUALIZADAS!*\n\n` +
                            `📊 **Grupo:** ${grupoNome}\n` +
                            `⏰ **Atualizado em:** ${new Date().toLocaleString('pt-BR')}`
                        );

                        console.log(`✅ Pagamento do grupo ${grupoNome} atualizado por admin global ${autorId}`);
                    } else {
                        await message.reply(`❌ *ERRO:* ${resultado.erro}`);
                    }
                } catch (error) {
                    await message.reply(`❌ *Erro inesperado:* ${error.message}`);
                    console.error('❌ Erro ao configurar pagamento:', error);
                }

                return;
            }

            // === COMANDO PARA VISUALIZAR CONFIGURAÇÃO ATUAL ===
            if (comando === '.ver-config') {
                const grupoId = message.from;
                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';

                const config = sistemaConfigGrupos.obterConfig(grupoId);
                const configPadrao = CONFIGURACAO_GRUPOS[grupoId];

                let resposta = `⚙️ *CONFIGURAÇÃO DO GRUPO*\n\n`;
                resposta += `📊 **Nome:** ${grupoNome}\n`;
                resposta += `🆔 **ID:** \`${grupoId}\`\n\n`;

                if (config) {
                    const pacotesNaTabela = sistemaConfigGrupos.contarPrecos(config.tabela);
                    const tabelaConfigurada = pacotesNaTabela > 0;
                    const pagamentoConfigurado = config.pagamento && !config.pagamento.includes('Configure');

                    // Status baseado na configuração
                    if (tabelaConfigurada && pagamentoConfigurado) {
                        resposta += `✅ **Status:** Completamente configurado\n`;
                    } else {
                        resposta += `⚠️ **Status:** Configuração incompleta\n`;
                        if (!tabelaConfigurada) {
                            resposta += `   ❌ Tabela de preços pendente\n`;
                        }
                        if (!pagamentoConfigurado) {
                            resposta += `   ❌ Formas de pagamento pendentes\n`;
                        }
                    }

                    resposta += `⏰ **Última atualização:** ${new Date(config.ultimaAtualizacao).toLocaleString('pt-BR')}\n`;
                    resposta += `👤 **Atualizado por:** ${config.atualizadoPor}\n`;
                    resposta += `📦 **Pacotes na tabela:** ${pacotesNaTabela}\n`;

                    const historico = sistemaConfigGrupos.obterHistorico(grupoId);
                    if (historico.sucesso) {
                        resposta += `📜 **Histórico:** ${historico.versoes} versões salvas\n`;
                    }

                    // Mostrar o que falta fazer
                    if (!tabelaConfigurada || !pagamentoConfigurado) {
                        resposta += `\n📝 **PENDENTE:**\n`;
                        if (!tabelaConfigurada) {
                            resposta += `1️⃣ Configure a tabela: \`.config-tabela\`\n`;
                        }
                        if (!pagamentoConfigurado) {
                            resposta += `2️⃣ Configure o pagamento: \`.config-pagamento\`\n`;
                        }
                    }

                } else if (configPadrao) {
                    const pacotesNaTabela = sistemaConfigGrupos.contarPrecos(configPadrao.tabela);
                    resposta += `📋 **Status:** Usando configuração padrão do código\n`;
                    resposta += `📦 **Pacotes na tabela:** ${pacotesNaTabela}`;
                } else {
                    resposta += `❌ **Status:** Não configurado\n\n`;
                    resposta += `💡 **Para adicionar este grupo:**\n`;
                    resposta += `Use o comando \`.configurar\` (apenas admin global)`;
                }

                if (configPadrao || config) {
                    resposta += `\n\n💡 **Comandos disponíveis:**\n`;
                    resposta += `• \`.config-tabela\` - Alterar tabela\n`;
                    resposta += `• \`.config-pagamento\` - Alterar pagamento\n`;
                    resposta += `• \`.restaurar-tabela\` - Restaurar versão anterior`;
                }

                await message.reply(resposta);
                return;
            }

            // === COMANDO PARA RESTAURAR VERSÃO ANTERIOR ===
            if (comando === '.restaurar-tabela') {
                const grupoId = message.from;
                const chat = await message.getChat();
                const grupoNome = chat.name || 'Grupo';
                const autorId = message.author || message.from;

                // VERIFICAR SE É ADMINISTRADOR GLOBAL
                const ehAdminGlobal = ADMINISTRADORES_GLOBAIS.includes(autorId);

                if (!ehAdminGlobal) {
                    await message.reply(
                        `🔒 *ACESSO NEGADO*\n\n` +
                        `⚠️ Apenas **administradores globais** podem restaurar configurações.\n\n` +
                        `📞 Solicite a um administrador do sistema.`
                    );
                    console.log(`🚫 ${autorId} tentou usar .restaurar-tabela sem permissão global`);
                    return;
                }

                try {
                    await message.reply('⏳ *Restaurando versão anterior...*');

                    const resultado = await sistemaConfigGrupos.restaurarVersaoAnterior(grupoId, autorId);

                    if (resultado.sucesso) {
                        // Recarregar configuração
                        const configMesclada = sistemaConfigGrupos.mesclarComConfigPadrao(CONFIGURACAO_GRUPOS);
                        Object.assign(CONFIGURACAO_GRUPOS, configMesclada);

                        await message.reply(
                            `✅ *VERSÃO ANTERIOR RESTAURADA!*\n\n` +
                            `📊 **Grupo:** ${grupoNome}\n` +
                            `⏰ **Restaurado em:** ${new Date().toLocaleString('pt-BR')}\n\n` +
                            `💡 Digite "tabela" para visualizar`
                        );

                        console.log(`✅ Tabela do grupo ${grupoNome} restaurada por admin global ${autorId}`);
                    } else {
                        await message.reply(`❌ *ERRO:* ${resultado.erro}`);
                    }
                } catch (error) {
                    await message.reply(`❌ *Erro inesperado:* ${error.message}`);
                    console.error('❌ Erro ao restaurar tabela:', error);
                }

                return;
            }

            if (comando === '.test_grupo') {
                const grupoAtual = message.from;
                const configGrupo = getConfiguracaoGrupo(grupoAtual);

                if (!configGrupo) {
                    await message.reply('❌ Este grupo não está configurado!');
                    return;
                }

                console.log(`🧪 Testando API MariaDB para grupo: ${configGrupo.nome}`);
                
                const resultado = await enviarParaGoogleSheets('TEST999', '88', '847777777', grupoAtual, configGrupo.nome, 'TestAdmin');
                
                if (resultado.sucesso) {
                    await message.reply(`✅ *Teste enviado para ${configGrupo.nome}!*\n\n📊 Row: ${resultado.row}\n🔍 O celular deste grupo deve processar em até 30 segundos.\n\n📱 *Grupo ID:* \`${grupoAtual}\``);
                } else {
                    await message.reply(`❌ *Erro no teste:* ${resultado.erro}`);
                }
                return;
            }

            if (comando === '.grupos_status') {
                let resposta = `📊 *STATUS DOS GRUPOS*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n`;
                
                for (const [grupoId, config] of Object.entries(CONFIGURACAO_GRUPOS)) {
                    const dadosGrupo = Array.from(cacheTransacoes.values()).filter(d => d.grupo_id === grupoId);
                    const hoje = dadosGrupo.filter(d => {
                        const dataItem = new Date(d.timestamp).toDateString();
                        return dataItem === new Date().toDateString();
                    });
                    
                    resposta += `🏢 *${config.nome}*\n`;
                    resposta += `   📈 Total: ${dadosGrupo.length}\n`;
                    resposta += `   📅 Hoje: ${hoje.length}\n`;
                    resposta += `   📊 Sheets: ${dadosGrupo.filter(d => d.metodo === 'google_sheets').length}\n`;
                    resposta += `   📱 Backup: ${dadosGrupo.filter(d => d.metodo === 'whatsapp_backup').length}\n`;
                    resposta += `   🆔 ID: \`${grupoId}\`\n\n`;
                }
                
                await message.reply(resposta);
                return;
            }

            if (comando === '.sheets') {
                const dados = obterDadosTasker();
                const hoje = obterDadosTaskerHoje();
                const sheets = dados.filter(d => d.metodo === 'google_sheets').length;
                const whatsapp = dados.filter(d => d.metodo === 'whatsapp_backup').length;
                
                let resposta = `📊 *GOOGLE SHEETS STATUS*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n`;
                resposta += `📈 Total enviado: ${dados.length}\n`;
                resposta += `📅 Hoje: ${hoje.length}\n`;
                resposta += `📊 Via API MariaDB: ${sheets}\n`;
                resposta += `📱 Via WhatsApp: ${whatsapp}\n\n`;
                // REMOVIDO: Fila de encaminhamento (sistema movido para outro bot)
                
                if (dados.length > 0) {
                    resposta += `📋 *Últimos 5 enviados:*\n`;
                    dados.slice(-5).forEach((item, index) => {
                        const metodo = item.metodo === 'google_sheets' ? '📊' : '📱';
                        resposta += `${index + 1}. ${metodo} ${item.dados} (${item.grupo})\n`;
                    });
                }
                
                await message.reply(resposta);
                return;
            }

            if (comando.startsWith('.clear_grupo ')) {
                const nomeGrupo = comando.replace('.clear_grupo ', '');
                const antes = cacheTransacoes.size;

                // Remover transações do grupo específico
                for (const [key, value] of cacheTransacoes.entries()) {
                    if (value.grupo && value.grupo.toLowerCase().includes(nomeGrupo.toLowerCase())) {
                        cacheTransacoes.delete(key);
                    }
                }

                const removidos = antes - cacheTransacoes.size;
                await message.reply(`🗑️ *${removidos} registros do grupo "${nomeGrupo}" removidos!*`);
                return;
            }

            if (comando === '.clear_sheets') {
                cacheTransacoes.clear();
                await message.reply('🗑️ *Cache de transações limpo!*');
                return;
            }

            // === COMANDOS TASKER - SISTEMA DE PACOTES ===
            
            // DEBUG: Verificar status do sistema de pacotes
            if (comando === '.debug_pacotes') {
                let resposta = `🔧 *DEBUG SISTEMA PACOTES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                resposta += `🔌 SISTEMA_PACOTES_ENABLED: ${process.env.SISTEMA_PACOTES_ENABLED}\n`;
                resposta += `📦 sistemaPacotes: ${sistemaPacotes ? 'INICIALIZADO' : 'NULL'}\n`;
                resposta += `👤 isAdminQualquer: ${isAdminQualquer}\n`;
                resposta += `📝 Comando original: "${message.body}"\n`;
                resposta += `🆔 Grupo ID: ${message.from}\n`;
                
                if (sistemaPacotes) {
                    resposta += `\n✅ Sistema de Pacotes está ATIVO e funcionando!`;
                } else {
                    resposta += `\n❌ Sistema de Pacotes está DESABILITADO ou falhou ao inicializar!`;
                }
                
                await message.reply(resposta);
                return;
            }
            
            if (comando === '.pacotes_tasker') {
                const dadosPacotes = obterDadosPacotesTasker();
                
                if (dadosPacotes.length === 0) {
                    await message.reply(`📦 *DADOS TASKER - PACOTES*\n\n❌ Nenhum cliente com pacote ativo para o Tasker.`);
                    return;
                }
                
                let resposta = `📦 *DADOS TASKER - PACOTES* (${dadosPacotes.length})\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                dadosPacotes.forEach((cliente, index) => {
                    const proximaRenovacao = new Date(cliente.proximaRenovacao);
                    resposta += `${index + 1}. **${cliente.numero}**\n`;
                    resposta += `   📋 Ref: ${cliente.referenciaOriginal}\n`;
                    resposta += `   📦 Tipo: ${cliente.tipoPacote}\n`;
                    resposta += `   📅 Dias restantes: ${cliente.diasRestantes}\n`;
                    resposta += `   ⏰ Próxima: ${proximaRenovacao.toLocaleString('pt-BR')}\n\n`;
                });
                
                resposta += `💡 *O Tasker pode acessar estes dados via função do bot para processar renovações automaticamente.*`;
                
                await message.reply(resposta);
                return;
            }
            
            if (comando === '.renovacoes_tasker') {
                const renovacoesPendentes = obterRenovacoesPendentesTasker();
                
                if (renovacoesPendentes.length === 0) {
                    await message.reply(`🔄 *RENOVAÇÕES TASKER*\n\n✅ Nenhuma renovação pendente nas próximas 6 horas.`);
                    return;
                }
                
                let resposta = `🔄 *RENOVAÇÕES TASKER* (${renovacoesPendentes.length})\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                renovacoesPendentes.forEach((cliente, index) => {
                    const proximaRenovacao = new Date(cliente.proximaRenovacao);
                    
                    resposta += `${index + 1}. **${cliente.numero}**\n`;
                    resposta += `   📋 Ref: ${cliente.referenciaOriginal}\n`;
                    resposta += `   📦 Tipo: ${cliente.tipoPacote}\n`;
                    resposta += `   📅 Dias restantes: ${cliente.diasRestantes}\n`;
                    resposta += `   ⏰ Próxima renovação: ${proximaRenovacao.toLocaleString('pt-BR')}\n\n`;
                });
                
                resposta += `💡 *Horários já calculados com 2h de antecipação em relação ao dia anterior.*`;
                
                await message.reply(resposta);
                return;
            }

            // === COMANDOS DO SISTEMA DE COMPRAS ===
            
            if (comando === '.compras_stats') {
                if (!sistemaCompras) {
                    await message.reply('❌ Sistema de compras não está ativo!');
                    return;
                }
                
                const estatisticas = await sistemaCompras.obterEstatisticas();
                
                let resposta = `🛒 *ESTATÍSTICAS DE COMPRAS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                resposta += `📊 Total de compradores: ${estatisticas.totalCompradores}\n`;
                resposta += `📅 Compradores hoje: ${estatisticas.compradoresHoje}\n`;
                resposta += `⏳ Compras pendentes: ${estatisticas.comprasPendentes}\n`;
                resposta += `💾 Total de megas hoje: ${estatisticas.totalMegasHoje >= 1024 ? (estatisticas.totalMegasHoje/1024).toFixed(1) + ' GB' : estatisticas.totalMegasHoje + ' MB'}\n\n`;
                
                if (estatisticas.ranking.length > 0) {
                    resposta += `🏆 *TOP 5 RANKING HOJE:*\n`;
                    estatisticas.ranking.slice(0, 5).forEach((cliente, index) => {
                        const megasFormatados = cliente.megasHoje >= 1024 ? `${(cliente.megasHoje/1024).toFixed(1)} GB` : `${cliente.megasHoje} MB`;
                        resposta += `${index + 1}º ${cliente.numero} - ${megasFormatados} (${cliente.comprasHoje}x)\n`;
                    });
                }
                
                await message.reply(resposta);
                return;
            }
            
            
            if (comando.startsWith('.comprador ')) {
                if (!sistemaCompras) {
                    await message.reply('❌ Sistema de compras não está ativo!');
                    return;
                }

                const numeroInput = comando.replace('.comprador ', '').trim();
                const numero = normalizarNumeroTelefone(numeroInput);

                if (!numero || numero.length !== 9) {
                    await message.reply('❌ Use: *.comprador 849123456*\nAceita formatos: 849123456, +258 849 123 456, 258849123456');
                    return;
                }

                const cliente = sistemaCompras.historicoCompradores[numero];
                
                if (!cliente) {
                    await message.reply(`❌ Cliente *${numero}* não encontrado no sistema de compras.`);
                    return;
                }
                
                const posicao = await sistemaCompras.obterPosicaoCliente(numero);
                const megasHojeFormatados = cliente.megasHoje >= 1024 ? `${(cliente.megasHoje/1024).toFixed(1)} GB` : `${cliente.megasHoje} MB`;
                const megasTotalFormatados = cliente.megasTotal >= 1024 ? `${(cliente.megasTotal/1024).toFixed(1)} GB` : `${cliente.megasTotal} MB`;
                
                let resposta = `👤 *PERFIL DO COMPRADOR*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                resposta += `📱 **Número:** ${numero}\n`;
                resposta += `🏆 **Posição hoje:** ${posicao.posicao}º lugar\n`;
                resposta += `📊 **Hoje:** ${megasHojeFormatados} (${cliente.comprasHoje} compras)\n`;
                resposta += `💎 **Total geral:** ${megasTotalFormatados} (${cliente.totalCompras} compras)\n`;
                resposta += `📅 **Primeira compra:** ${new Date(cliente.primeiraCompra).toLocaleDateString('pt-BR')}\n`;
                resposta += `⏰ **Última compra:** ${new Date(cliente.ultimaCompra).toLocaleDateString('pt-BR')}\n`;
                
                await message.reply(resposta);
                return;
            }

            // === NOVOS COMANDOS PARA DETECÇÃO DE GRUPOS ===
            if (comando === '.grupos') {
                try {
                    let resposta = `📋 *GRUPOS DETECTADOS*\n⚠ NB: Válido apenas para Vodacom━━━━━━━━\n\n`;
                    
                    const chats = await client.getChats();
                    const grupos = chats.filter(chat => chat.isGroup);
                    
                    resposta += `📊 Total de grupos: ${grupos.length}\n\n`;
                    
                    for (const grupo of grupos) {
                        const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupo.id._serialized);
                        const status = isMonitorado ? '✅' : '❌';
                        
                        resposta += `${status} *${grupo.name}*\n`;
                        resposta += `   🆔 \`${grupo.id._serialized}\`\n`;
                        resposta += `   👥 ${grupo.participants.length} membros\n\n`;
                    }
                    
                    resposta += `\n🔧 *Para adicionar grupo:*\nCopie ID e adicione em CONFIGURACAO_GRUPOS`;
                    
                    await message.reply(resposta);
                    
                    console.log(`\n📋 COMANDO .grupos executado - ${grupos.length} grupos encontrados`);
                    grupos.forEach(grupo => {
                        const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupo.id._serialized);
                        console.log(`${isMonitorado ? '✅' : '❌'} ${grupo.name}: ${grupo.id._serialized}`);
                    });
                    
                } catch (error) {
                    console.error('❌ Erro ao listar grupos:', error);
                    await message.reply('❌ Erro ao obter lista de grupos');
                }
                return;
            }

            if (comando === '.grupo_atual') {
                if (!message.from.endsWith('@g.us')) {
                    await message.reply('❌ Use este comando em um grupo!');
                    return;
                }
                
                await logGrupoInfo(message.from, 'COMANDO .grupo_atual');
                
                const configGrupo = getConfiguracaoGrupo(message.from);
                const status = configGrupo ? '✅ CONFIGURADO' : '❌ NÃO CONFIGURADO';
                
                await message.reply(
                    `📋 *INFORMAÇÕES DESTE GRUPO*\n\n` +
                    `🆔 ID: \`${message.from}\`\n` +
                    `📊 Status: ${status}\n\n` +
                    `${configGrupo ? `🏢 Nome: ${configGrupo.nome}` : '🔧 Precisa ser configurado'}\n\n` +
                    `📝 Verifique o console para detalhes completos`
                );
                return;
            }
        }

        // === FUNÇÃO PARA DETECTAR INTENÇÃO DE .MEUCODIGO ===
        async function detectarIntencaoMeuCodigo(texto) {
            // Primeiro, verificação básica por padrões (sem IA - economia)
            const textoLimpo = texto.toLowerCase().trim();

            // Padrões mais comuns (com e sem espaços)
            const padroesDiretos = [
                // Versões sem espaço
                'meucodigo',
                'meucódigo',
                '.meucodigo',
                '.meucódigo',

                // Versões com espaço
                'meu codigo',
                'meu código',
                '.meu codigo',
                '.meu código',

                // Outras variações
                'meu codigo de referencia',
                'meu código de referência',
                'ver meu codigo',
                'ver meu código',
                'qual meu codigo',
                'qual meu código',
                'qual o meu codigo',
                'qual o meu código',
                'como ver meu codigo',
                'como ver meu código',
                'minha referencia',
                'minha referência',
                'codigo meu',
                'código meu',
                'codigo pessoal',
                'código pessoal',
                'meu referencia',
                'meu referência'
            ];

            // Verificação direta (mais rápido)
            for (const padrao of padroesDiretos) {
                if (textoLimpo.includes(padrao)) {
                    console.log(`🎯 DETECTADO: "${texto}" → padrão "${padrao}"`);
                    return true;
                }
            }

            // Detecção por IA desativada (função obterResposta não implementada)
            // A detecção por padrões acima já é suficiente
            return false;
        }

        // === DETECÇÃO INTELIGENTE DE .MEUCODIGO (QUALQUER FORMATO) ===
        if (message.type === 'chat' && await detectarIntencaoMeuCodigo(message.body)) {
            const remetente = message.author || message.from;
            let codigo = null;

            // Verificar se já tem código (buscar em TODOS os códigos)
            console.log(`🔍 Procurando código existente para: ${remetente}`);
            for (const [cod, dados] of Object.entries(codigosReferencia)) {
                if (dados.dono === remetente) {
                    codigo = cod;
                    console.log(`✅ Código existente encontrado: ${codigo}`);
                    break;
                }
            }

            // Se não tem, criar novo
            if (!codigo) {
                console.log(`📝 Criando NOVO código para: ${remetente}`);
                codigo = gerarCodigoReferencia(remetente);
                const dadosCodigo = {
                    dono: remetente,
                    nome: message._data.notifyName || 'N/A',
                    criado: new Date().toISOString(),
                    ativo: true
                };

                // Salvar no sistema legado
                codigosReferencia[codigo] = dadosCodigo;

                // CORRIGIDO: Sincronizar com SistemaBonus
                if (sistemaBonus) {
                    sistemaBonus.codigosReferencia[codigo] = { ...dadosCodigo };
                    await sistemaBonus.salvarDados();
                    console.log(`✅ Código ${codigo} salvo no SistemaBonus`);
                }

                // Salvar sistema legado
                console.log(`💾 Salvando código ${codigo} no sistema legado...`);
                await salvarDadosReferencia();
                console.log(`✅ Código ${codigo} salvo com sucesso!`);
            }

            await message.reply(
                `🎁 *SEU CÓDIGO DE REFERÊNCIA*\n\n` +
                `📋 Código: *${codigo}*\n\n` +
                `🎯 *Como usar:*\n` +
                `1. Convide amigos para o grupo\n` +
                `2. Peça para eles digitarem:\n` +
                `   *.convite ${codigo}*\n\n` +
                `💰 *Ganhe 200MB* a cada compra deles!\n` +
                `🎉 *Primeiras 5 compras* = 1GB cada\n\n` +
                `🚀 Sem limite de amigos que pode convidar!`
            );
            console.log(`🎁 Código de referência enviado: ${codigo} para ${remetente}`);
            return;
        }

        // === COMANDOS DE REFERÊNCIA E BÔNUS (TODOS USUÁRIOS) ===
        if (message.type === 'chat' && message.body.startsWith('.')) {
            const comando = message.body.toLowerCase().trim();
            const remetente = message.author || message.from;

            // === OUTROS COMANDOS COM PONTO ===

            // .convite CODIGO - Registrar referência
            if (comando.startsWith('.convite ')) {
                const codigo = comando.split(' ')[1]?.toUpperCase();
                
                if (!codigo) {
                    await message.reply('❌ Use: *.convite CODIGO*\nExemplo: *.convite AB12CD*');
                    return;
                }
                
                // Verificar se código existe
                if (!codigosReferencia[codigo]) {
                    await message.reply(`❌ Código *${codigo}* não encontrado!\n\n💡 Peça para quem te convidou verificar o código com *.meucodigo*`);
                    return;
                }
                
                // Verificar se já tem referência
                if (referenciasClientes[remetente]) {
                    await message.reply(`⚠️ Você já foi convidado por alguém!\n\nNão é possível usar outro código de referência.`);
                    return;
                }
                
                // Verificar se não está tentando usar próprio código
                if (codigosReferencia[codigo].dono === remetente) {
                    await message.reply('❌ Não podes usar teu próprio código de referência! 😅');
                    return;
                }

                // NOVA VALIDAÇÃO: Verificar se é elegível (entrou nos últimos 5 dias)
                if (!isElegivelParaCodigo(remetente, message.from)) {
                    await message.reply(
                        `⏳ *CÓDIGO EXPIRADO PARA SEU PERFIL*\n\n` +
                        `❌ Códigos de referência só funcionam para membros que entraram no grupo nos últimos 5 dias.\n\n` +
                        `🤔 *Por que isso acontece?*\n` +
                        `• Sistema anti-abuse\n` +
                        `• Incentiva convites genuínos\n` +
                        `• Protege economia do grupo\n\n` +
                        `💡 *Solução:* Você ainda pode gerar seu próprio código com *.meucodigo* e convidar outros!`
                    );
                    return;
                }
                
                // Registrar referência
                const dadosReferencia = {
                    convidadoPor: codigosReferencia[codigo].dono,
                    codigo: codigo,
                    dataRegistro: new Date().toISOString(),
                    comprasRealizadas: 0
                };

                // Salvar no sistema legado
                referenciasClientes[remetente] = dadosReferencia;

                const convidadorId = codigosReferencia[codigo].dono;
                const nomeConvidador = codigosReferencia[codigo].nome;

                // CORRIGIDO: Marcar código como usado
                codigosReferencia[codigo].usado = true;
                codigosReferencia[codigo].usadoPor = remetente;
                codigosReferencia[codigo].dataUso = new Date().toISOString();

                // CORRIGIDO: Inicializar saldo de bônus do convidador
                if (!bonusSaldos[convidadorId]) {
                    bonusSaldos[convidadorId] = {
                        saldo: 0,
                        detalhesReferencias: {},
                        historicoSaques: [],
                        totalReferencias: 0
                    };
                }
                bonusSaldos[convidadorId].totalReferencias++;

                // CORRIGIDO: Sincronizar com SistemaBonus
                if (sistemaBonus) {
                    console.log(`🔄 Sincronizando referência com SistemaBonus...`);

                    // Atualizar referência em todos os formatos (compatibilidade)
                    const formatos = [
                        remetente,
                        remetente.replace('@c.us', '@lid'),
                        remetente.replace('@lid', '@c.us')
                    ];

                    formatos.forEach(formato => {
                        sistemaBonus.referenciasClientes[formato] = { ...dadosReferencia };
                    });

                    // Atualizar código
                    sistemaBonus.codigosReferencia[codigo] = { ...codigosReferencia[codigo] };

                    // Inicializar saldo no sistemaBonus
                    const formatosConvidador = [
                        convidadorId,
                        convidadorId.replace('@c.us', '@lid'),
                        convidadorId.replace('@lid', '@c.us')
                    ];

                    formatosConvidador.forEach(formato => {
                        if (!sistemaBonus.bonusSaldos[formato]) {
                            sistemaBonus.bonusSaldos[formato] = {
                                saldo: 0,
                                detalhesReferencias: {},
                                historicoSaques: [],
                                totalReferencias: 0
                            };
                        }
                        sistemaBonus.bonusSaldos[formato].totalReferencias++;
                    });

                    // Salvar no SistemaBonus
                    await sistemaBonus.salvarDados();
                    console.log(`✅ Referência sincronizada com SistemaBonus`);
                }

                // CORRIGIDO: Salvar IMEDIATAMENTE para garantir persistência
                console.log(`💾 Salvando uso do código ${codigo} no sistema legado...`);
                await salvarDadosReferencia();

                // Salvar arquivo de membros se foi atualizado
                try {
                    await fs.writeFile(ARQUIVO_MEMBROS, JSON.stringify(membrosEntrada, null, 2));
                    console.log(`✅ Membros entrada salvos com sucesso!`);
                } catch (error) {
                    console.log('⚠️ Erro ao salvar membros entrada:', error.message);
                }
                
                // CORRIGIDO: Remover @lid e @c.us das menções
                const convidadorLimpo = convidadorId.replace('@c.us', '').replace('@lid', '');

                await client.sendMessage(message.from,
                    `✅ *CÓDIGO APLICADO COM SUCESSO!*\n\n` +
                    `🎉 @${convidadorLimpo} te convidou - registrado!\n\n` +
                    `💎 *Benefícios:*\n` +
                    `• Nas tuas próximas 5 compras, @${convidadorLimpo} ganha 200MB cada\n` +
                    `• Tu recebes teus megas normalmente\n` +
                    `• Ajudas um amigo a ganhar bônus!\n\n` +
                    `🚀 *Próximo passo:* Faz tua primeira compra!`, {
                    mentions: [convidadorId]
                });
                return;
            }

            // .ignorados - Ver lista de bots ignorados (ADMIN ONLY)
            if (comando === '.ignorados' || comando === '.bots') {
                if (!isAdministrador(remetente)) {
                    await message.reply('❌ Comando disponível apenas para administradores.');
                    return;
                }

                const listaBots = BOTS_IGNORADOS.map((bot, index) =>
                    `${index + 1}. ${bot}`
                ).join('\n');

                await message.reply(
                    `🤖 *BOTS IGNORADOS*\n\n` +
                    `O bot ignora automaticamente mensagens de:\n\n` +
                    `${listaBots}\n\n` +
                    `📝 Total: ${BOTS_IGNORADOS.length} bots\n\n` +
                    `💡 Para adicionar mais bots, edite a lista BOTS_IGNORADOS no código.`
                );
                return;
            }

            // .cache - Ver estatísticas do cache anti-duplicatas de comprovantes (ADMIN ONLY)
            if (comando === '.cache') {
                if (!isAdministrador(remetente)) {
                    await message.reply('❌ Comando disponível apenas para administradores.');
                    return;
                }

                const totalComprovantesCache = cacheComprovantesRecentes.size;
                const agora = Date.now();
                let comprovantesAtivos = 0;

                for (const [hash, registro] of cacheComprovantesRecentes.entries()) {
                    if (agora - registro.timestamp < CACHE_COMPROVANTE_TTL) {
                        comprovantesAtivos++;
                    }
                }

                await message.reply(
                    `🗂️ *CACHE ANTI-DUPLICATAS DE COMPROVANTES*\n\n` +
                    `📊 Total no cache: ${totalComprovantesCache} comprovantes\n` +
                    `✅ Ativos (< 5min): ${comprovantesAtivos}\n` +
                    `⏰ TTL: 5 minutos\n` +
                    `📦 Limite máximo: 500 comprovantes\n\n` +
                    `💡 Apenas COMPROVANTES duplicados são bloqueados.\n` +
                    `📝 Outras mensagens (comandos, números) não são controladas.`
                );
                return;
            }

            // .bonus - Ver saldo de bônus
            if (comando === '.bonus' || comando === '.saldo') {
                console.log(`🔍 Buscando saldo para: ${remetente}`);
                const saldo = await buscarSaldoBonus(remetente);
                
                if (!saldo || saldo.saldo === 0) {
                    await message.reply(
                        `💰 *TEU SALDO DE BÔNUS*\n\n` +
                        `🎁 Total acumulado: *0MB*\n` +
                        `📊 Referências ativas: *0 pessoas*\n\n` +
                        `🚀 *Como ganhar bônus:*\n` +
                        `1. Gera teu código com *.meucodigo*\n` +
                        `2. Convida amigos para o grupo\n` +
                        `3. Eles usam *.convite TEUCODIGO*\n` +
                        `4. A cada compra deles, ganhas 200MB\n` +
                        `5. Com 1GB+ podes sacar com *.sacar*`
                    );
                    return;
                }
                
                const saldoGB = (saldo.saldo / 1024).toFixed(2);
                const podeSacar = saldo.saldo >= 1024;
                const referenciasAtivas = Object.keys(saldo.detalhesReferencias || {}).length;
                
                let detalhes = '';
                if (saldo.detalhesReferencias) {
                    Object.entries(saldo.detalhesReferencias).forEach(([cliente, dados]) => {
                        const nome = dados.nome || 'Cliente';
                        detalhes += `• ${nome}: ${dados.compras}/5 compras (${dados.bonusGanho}MB ganhos)\n`;
                    });
                }
                
                await message.reply(
                    `💰 *TEU SALDO DE BÔNUS*\n\n` +
                    `🎁 Total acumulado: *${saldo.saldo}MB* (${saldoGB}GB)\n` +
                    `📊 Referências ativas: *${referenciasAtivas} pessoas*\n` +
                    `💡 Mínimo para saque: 1GB (1024MB)\n\n` +
                    `${detalhes ? `👥 *Detalhes das referências:*\n${detalhes}\n` : ''}` +
                    `${podeSacar ? '🚀 *Pronto para sacar!*\nUse: *.sacar 1GB 845123456*' : '⏳ Incentiva teus convidados a comprar!'}`
                );
                return;
            }

            // .sacar QUANTIDADE NUMERO - Solicitar saque
            if (comando.startsWith('.sacar ')) {
                const partes = comando.split(' ');
                if (partes.length < 3) {
                    await message.reply(
                        `❌ *FORMATO INCORRETO*\n\n` +
                        `✅ Use: *.sacar QUANTIDADE NUMERO*\n\n` +
                        `📋 *Exemplos:*\n` +
                        `• *.sacar 1GB 845123456*\n` +
                        `• *.sacar 2048MB 847654321*\n` +
                        `• *.sacar 1.5GB 843210987*`
                    );
                    return;
                }
                
                const quantidadeStr = partes[1].toUpperCase();
                const numeroDestino = partes[2];
                
                // Validar número
                if (!/^8[0-9]{8}$/.test(numeroDestino)) {
                    await message.reply(`❌ Número inválido: *${numeroDestino}*\n\n✅ Use formato: 8XXXXXXXX`);
                    return;
                }
                
                // Converter quantidade para MB
                let quantidadeMB = 0;
                if (quantidadeStr.endsWith('GB')) {
                    const gb = parseFloat(quantidadeStr.replace('GB', ''));
                    quantidadeMB = gb * 1024;
                } else if (quantidadeStr.endsWith('MB')) {
                    quantidadeMB = parseInt(quantidadeStr.replace('MB', ''));
                } else {
                    await message.reply(`❌ Formato inválido: *${quantidadeStr}*\n\n✅ Use: 1GB, 1.5GB, 1024MB, etc.`);
                    return;
                }
                
                // Verificar saldo (buscar em todos os formatos)
                console.log(`🔍 Buscando saldo para saque: ${remetente}`);
                const saldo = await buscarSaldoBonus(remetente);
                if (!saldo || saldo.saldo < quantidadeMB) {
                    const saldoAtual = saldo ? saldo.saldo : 0;
                    await message.reply(
                        `❌ *SALDO INSUFICIENTE*\n\n` +
                        `💰 Teu saldo: ${saldoAtual}MB\n` +
                        `🎯 Solicitado: ${quantidadeMB}MB\n\n` +
                        `💡 Precisas de mais ${quantidadeMB - saldoAtual}MB\n` +
                        `🚀 Convida mais amigos para ganhar bônus!`
                    );
                    return;
                }
                
                // Verificar mínimo
                if (quantidadeMB < 1024) {
                    await message.reply(`❌ Valor mínimo para saque: *1GB (1024MB)*\n\n🎯 Solicitado: ${quantidadeMB}MB`);
                    return;
                }
                
                // === VALIDAÇÕES ADICIONAIS DE SEGURANÇA ===

                // Verificar se já existe saque pendente deste cliente
                const saquePendente = Object.values(pedidosSaque).find(s =>
                    s.cliente === remetente &&
                    s.status === 'pendente' &&
                    s.numeroDestino === numeroDestino
                );

                if (saquePendente) {
                    await message.reply(
                        `⚠️ *SAQUE PENDENTE DETECTADO*\n\n` +
                        `🔖 Referência: *${saquePendente.referencia}*\n` +
                        `📱 Número: ${saquePendente.numeroDestino}\n` +
                        `💎 Quantidade: ${saquePendente.quantidade}MB\n` +
                        `📅 Data: ${new Date(saquePendente.dataSolicitacao).toLocaleString('pt-BR')}\n\n` +
                        `⏳ Aguarde o processamento do saque anterior antes de solicitar um novo.\n` +
                        `📞 Prazo: até 24h`
                    );
                    return;
                }

                // Limite diário de saques REMOVIDO - Agora sem limite!

                // === GERAR REFERÊNCIA ÚNICA PARA SAQUE ===
                const agora = new Date();
                let referenciaSaque = null;
                let tentativasGeracao = 0;
                const maxTentativasGeracao = 10;

                // Tentar gerar referência única
                while (!referenciaSaque && tentativasGeracao < maxTentativasGeracao) {
                    tentativasGeracao++;

                    // Gerar referência baseada em data + contador + tentativa
                    const anoMesDia = `${agora.getFullYear().toString().slice(-2)}${String(agora.getMonth() + 1).padStart(2, '0')}${String(agora.getDate()).padStart(2, '0')}`;
                    const contador = String(Object.keys(pedidosSaque).length + tentativasGeracao).padStart(3, '0');
                    const timestamp = String(Date.now()).slice(-3); // Últimos 3 dígitos do timestamp
                    const refCandidato = `SAQ${anoMesDia}${contador}`;

                    console.log(`🔄 Tentativa ${tentativasGeracao}: Gerando referência ${refCandidato}`);

                    // Verificar se já existe localmente
                    if (pedidosSaque[refCandidato]) {
                        console.warn(`⚠️ Referência ${refCandidato} já existe localmente, tentando outra...`);
                        continue;
                    }

                    // Verificar se já existe na planilha (fazer verificação prévia)
                    // Por enquanto, aceitar se não existir localmente
                    referenciaSaque = refCandidato;
                    console.log(`✅ Referência gerada: ${referenciaSaque}`);
                }

                // Se não conseguiu gerar referência única após todas as tentativas
                if (!referenciaSaque) {
                    console.error(`❌ ERRO CRÍTICO: Não foi possível gerar referência única após ${maxTentativasGeracao} tentativas`);
                    await message.reply(
                        `❌ *ERRO TEMPORÁRIO*\n\n` +
                        `⚠️ Ocorreu um erro ao gerar a referência do saque.\n` +
                        `🔄 Por favor, tente novamente em alguns segundos.\n\n` +
                        `📞 Se o problema persistir, contate o suporte.`
                    );
                    return;
                }

                console.log(`💰 INICIANDO SAQUE: ${referenciaSaque} para ${remetente} - ${quantidadeMB}MB`);

                // Criar pedido
                const pedido = {
                    referencia: referenciaSaque,
                    cliente: remetente,
                    nomeCliente: message._data.notifyName || 'N/A',
                    quantidade: quantidadeMB,
                    numeroDestino: numeroDestino,
                    dataSolicitacao: agora.toISOString(),
                    status: 'pendente',
                    grupo: message.from
                };

                // Salvar pedido ANTES de debitar
                pedidosSaque[referenciaSaque] = pedido;
                console.log(`✅ Pedido ${referenciaSaque} criado no sistema`);

                // === SALVAMENTO IMEDIATO #1: PEDIDO CRIADO ===
                console.log(`💾 Salvando pedido de saque imediatamente...`);
                await salvarDadosReferencia();

                // Debitar do saldo em todos os formatos
                await atualizarSaldoBonus(remetente, (saldoObj) => {
                    saldoObj.saldo -= quantidadeMB;
                    saldoObj.historicoSaques = saldoObj.historicoSaques || [];
                    saldoObj.historicoSaques.push({
                        referencia: referenciaSaque,
                        quantidade: quantidadeMB,
                        data: agora.toISOString()
                    });
                });
                console.log(`✅ Saldo debitado: -${quantidadeMB}MB`);

                // === SALVAMENTO IMEDIATO #2: SALDO DEBITADO ===
                console.log(`💾 Salvando saldo atualizado imediatamente...`);
                await salvarDadosReferencia();

                // Enviar para Tasker/Planilha com validação e RETRY automático em caso de duplicata
                const quantidadeFormatada = quantidadeMB >= 1024 ? `${(quantidadeMB/1024).toFixed(2)}GB` : `${quantidadeMB}MB`;
                let resultadoEnvio;
                let referenciaFinal = referenciaSaque;
                let tentativasEnvio = 0;
                const maxTentativasEnvio = 5;

                // Loop de retry com geração de nova referência em caso de duplicata
                while (tentativasEnvio < maxTentativasEnvio) {
                    tentativasEnvio++;

                    try {
                        console.log(`📊 Tentativa ${tentativasEnvio}/${maxTentativasEnvio}: Enviando saque ${referenciaFinal} para planilha...`);
                        resultadoEnvio = await enviarParaTasker(
                            referenciaFinal,
                            quantidadeMB,
                            numeroDestino,
                            message.from,
                            message._data.notifyName || 'Cliente'
                        );

                        // === VERIFICAR SE É DUPLICATA NA PLANILHA ===
                        if (resultadoEnvio && resultadoEnvio.duplicado) {
                            console.warn(`⚠️ DUPLICATA DETECTADA na planilha: ${referenciaFinal} (Status: ${resultadoEnvio.status_existente})`);

                            // Gerar nova referência independente do status
                            console.log(`🔄 Gerando nova referência para evitar duplicata (Status: ${resultadoEnvio.status_existente})...`);

                            // Remover pedido antigo
                            delete pedidosSaque[referenciaFinal];

                            // Gerar nova referência
                            const novaRefSufixo = String(Date.now()).slice(-4); // Últimos 4 dígitos do timestamp
                            const novaRef = `SAQ${agora.getFullYear().toString().slice(-2)}${String(agora.getMonth() + 1).padStart(2, '0')}${String(agora.getDate()).padStart(2, '0')}${novaRefSufixo}`;

                            console.log(`🆕 Nova referência gerada: ${novaRef}`);
                            referenciaFinal = novaRef;

                            // Atualizar histórico com nova referência
                            await atualizarSaldoBonus(remetente, (saldoObj) => {
                                if (saldoObj.historicoSaques && saldoObj.historicoSaques.length > 0) {
                                    saldoObj.historicoSaques[saldoObj.historicoSaques.length - 1].referencia = novaRef;
                                }
                            });

                            // Criar novo pedido com nova referência
                            pedidosSaque[novaRef] = {
                                referencia: novaRef,
                                cliente: remetente,
                                nomeCliente: message._data.notifyName || 'N/A',
                                quantidade: quantidadeMB,
                                numeroDestino: numeroDestino,
                                dataSolicitacao: agora.toISOString(),
                                status: 'pendente',
                                grupo: message.from
                            };

                            console.log(`✅ Pedido recriado com nova referência: ${novaRef}`);

                            // === SALVAMENTO IMEDIATO #5: NOVA REFERÊNCIA GERADA ===
                            console.log(`💾 Salvando nova referência imediatamente...`);
                            await salvarDadosReferencia();

                            // Continuar loop para tentar enviar com nova referência
                            continue;
                        }

                        // === VERIFICAR SE O ENVIO FOI BEM-SUCEDIDO ===
                        if (!resultadoEnvio || !resultadoEnvio.sucesso) {
                            console.error('❌ ERRO: Saque não foi enviado para a planilha!');
                            console.error('Resultado:', resultadoEnvio);

                            // Se não for duplicata, não tentar novamente - sair do loop
                            break;
                        }

                        // Sucesso! Sair do loop
                        console.log(`✅ Saque ${referenciaFinal} enviado com sucesso!`);
                        break;

                    } catch (error) {
                        console.error(`❌ Exceção na tentativa ${tentativasEnvio}:`, error.message);
                        // Em caso de exceção, sair do loop
                        break;
                    }
                }

                // Após todas as tentativas, verificar resultado final
                if (!resultadoEnvio || !resultadoEnvio.sucesso) {
                    console.error('❌ FALHA FINAL: Saque não foi enviado após todas as tentativas');
                    console.error('Resultado final:', resultadoEnvio);

                    // Reverter o débito do saldo
                    console.log(`🔄 Revertendo débito de ${quantidadeMB}MB...`);
                    await atualizarSaldoBonus(remetente, (saldoObj) => {
                        saldoObj.saldo += quantidadeMB;
                        if (saldoObj.historicoSaques && saldoObj.historicoSaques.length > 0) {
                            saldoObj.historicoSaques.pop();
                        }
                    });

                    // Remover pedido da lista
                    delete pedidosSaque[referenciaFinal];
                    console.log(`✅ Saldo restaurado e pedido removido`);

                    // === SALVAMENTO IMEDIATO #4: REVERSÃO DE SALDO ===
                    console.log(`💾 Salvando reversão de saldo imediatamente...`);
                    await salvarDadosReferencia();

                    await message.reply(
                        `❌ *ERRO AO PROCESSAR SAQUE*\n\n` +
                        `⚠️ Não foi possível enviar o pedido para a planilha.\n` +
                        `💰 Seu saldo foi restaurado.\n` +
                        `🔄 Por favor, tente novamente em alguns minutos.\n\n` +
                        `📞 Se o problema persistir, contate o suporte.\n` +
                        `🔖 Ref: ${referenciaFinal}`
                    );

                    // Tentar notificar admin
                    try {
                        const grupoInfo = await client.getChatById(message.from);
                        if (grupoInfo && grupoInfo.participants) {
                            const admins = grupoInfo.participants.filter(p => p.isAdmin || p.isSuperAdmin);
                            if (admins.length > 0) {
                                const adminId = admins[0].id._serialized;
                                const nomeClienteSeguro = sanitizeText(message._data.notifyName || 'N/A');

                                await client.sendMessage(adminId,
                                    `🚨 *ALERTA: FALHA NO SISTEMA DE SAQUE*\n\n` +
                                    `❌ Saque falhou após ${tentativasEnvio} tentativas.\n\n` +
                                    `📋 *Detalhes:*\n` +
                                    `🔖 Referência: ${referenciaFinal}\n` +
                                    `👤 Cliente: ${nomeClienteSeguro}\n` +
                                    `💰 Valor: ${quantidadeMB}MB\n\n` +
                                    `✅ Saldo restaurado.\n` +
                                    `🔧 Verifique API MariaDB.`
                                );
                                console.log(`📧 Notificação enviada ao admin`);
                            }
                        }
                    } catch (notifyError) {
                        console.error('❌ Falha ao notificar admin:', notifyError.message);
                    }

                    return;
                }

                // Sucesso! Marcar pedido como enviado
                console.log(`✅ Saque ${referenciaFinal} enviado com sucesso!`);
                if (pedidosSaque[referenciaFinal]) {
                    pedidosSaque[referenciaFinal].status = 'enviado';
                    pedidosSaque[referenciaFinal].dataEnvio = new Date().toISOString();

                    // === SALVAMENTO IMEDIATO #3: PEDIDO ENVIADO ===
                    console.log(`💾 Salvando status 'enviado' imediatamente...`);
                    await salvarDadosReferencia();
                }

                // Enviar mensagem de confirmação ao cliente
                try {
                    const saldoAtualizado = await buscarSaldoBonus(remetente);
                    const novoSaldo = saldoAtualizado ? saldoAtualizado.saldo : 0;

                    // Sanitizar nome do cliente (fallback para nome original se falhar)
                    let nomeCliente = message._data.notifyName || 'N/A';
                    try {
                        nomeCliente = sanitizeText(nomeCliente);
                    } catch (e) {
                        console.warn('⚠️ Erro ao sanitizar nome, usando original');
                    }

                    const mensagemSucesso = `✅ *SOLICITAÇÃO DE SAQUE CRIADA*\n\n` +
                        `👤 Cliente: ${nomeCliente}\n` +
                        `📱 Número: ${numeroDestino}\n` +
                        `💎 Quantidade: ${quantidadeFormatada}\n` +
                        `🔖 Referência: *${referenciaFinal}*\n` +
                        `⏰ Processamento: até 24h\n\n` +
                        `💰 *Novo saldo:* ${novoSaldo}MB\n\n` +
                        `✅ Pedido enviado para processamento!\n` +
                        `✅ Obrigado por usar nosso sistema de referências!`;

                    console.log(`📤 Enviando confirmação de saque no GRUPO...`);

                    // Enviar no GRUPO (reply na mensagem original)
                    await message.reply(mensagemSucesso);
                    console.log(`✅ Confirmação de saque enviada no GRUPO com sucesso!`);

                } catch (errorMensagem) {
                    console.error('❌ ERRO ao enviar mensagem de confirmação:', errorMensagem);
                    console.error('Stack:', errorMensagem.stack);

                    // Tentar enviar versão simplificada
                    try {
                        await client.sendMessage(message.from,
                            `✅ *SAQUE CRIADO*\n\n` +
                            `🔖 Referência: ${referenciaFinal}\n` +
                            `💎 Quantidade: ${quantidadeFormatada}\n` +
                            `📱 Número: ${numeroDestino}\n\n` +
                            `✅ Pedido em processamento!`
                        );
                        console.log(`✅ Mensagem simplificada enviada`);
                    } catch (errorSimples) {
                        console.error('❌ Falha também na mensagem simplificada:', errorSimples.message);
                    }
                }
                return;
            }
        }

        // === DETECÇÃO DE GRUPOS NÃO CONFIGURADOS ===
        if (message.from.endsWith('@g.us') && !isGrupoMonitorado(message.from) && !message.fromMe) {
            if (!gruposLogados.has(message.from)) {
                await logGrupoInfo(message.from, 'MENSAGEM RECEBIDA');
                gruposLogados.add(message.from);
                
                // Limpar cache a cada 50 grupos para evitar memory leak
                if (gruposLogados.size > 50) {
                    gruposLogados.clear();
                }
            }
        }

        // === PROCESSAMENTO DE GRUPOS ===
        if (!message.from.endsWith('@g.us') || !isGrupoMonitorado(message.from)) {
            return;
        }

        const configGrupo = getConfiguracaoGrupo(message.from);
        if (!configGrupo || message.fromMe) {
            return;
        }

        // === DETECÇÃO DE NOVOS MEMBROS (ALTERNATIVO) ===
        await detectarNovoMembro(message.from, autorMensagem, configGrupo);

        // === MODERAÇÃO ===
        if (message.type === 'chat') {
            // Verificar se é um comando administrativo antes da moderação
            const isComandoAdmin = message.body.startsWith('.') && (
                message.body.startsWith('.addcomando ') ||
                message.body.startsWith('.delcomando ') ||
                message.body.startsWith('.comandos') ||
                message.body.startsWith('.addgatilho ') ||
                message.body.startsWith('.delgatilho ') ||
                message.body.startsWith('.gatilhos') ||
                message.body.startsWith('.ia') ||
                message.body.startsWith('.stats') ||
                message.body.startsWith('.sheets') ||
                message.body.startsWith('.test_') ||
                message.body.startsWith('.grupos') ||
                message.body.startsWith('.clear_') ||
                message.body.startsWith('.ranking') ||
                message.body.startsWith('.inativos') ||
                message.body.startsWith('.detetives') ||
                message.body.startsWith('.semcompra') ||
                message.body.startsWith('.resetranking')
            );

            // Verificar se é admin executando comando
            const autorModeracaoMsg = message.author || message.from;
            const isAdminExecutando = isAdministrador(autorModeracaoMsg);

            // Pular moderação SOMENTE para comandos administrativos executados por admins
            const isPularModeracao = isComandoAdmin && isAdminExecutando;

            if (!isPularModeracao) {
                // Verificar Anti-Spam primeiro
                const ehSpam = await verificarAntiSpam(message, client);
                if (ehSpam) {
                    return; // Spam detectado e tratado
                }

                const analise = contemConteudoSuspeito(message.body);

                if (analise.suspeito) {
                    console.log(`🚨 Conteúdo suspeito detectado de ${autorModeracaoMsg}`);
                    await aplicarModeracao(message, "Link detectado");
                    return;
                }
            }
        }

        // === PROCESSAMENTO DE IMAGENS DESATIVADO ===
        if (message.type === 'image') {
            console.log(`📸 Imagem recebida - Processamento desativado`);

            await message.reply(
                '❌ Processamento de imagens desativado\n' +
                '📄 Solicitamos que o comprovante seja enviado em formato de texto.\n\n' +
                'ℹ️ Esta medida foi adotada para garantir que o sistema funcione de forma mais rápida, estável e com menos falhas.'
            );
            return;
        }

        if (message.type !== 'chat') {
            return;
        }

        // Comandos de tabela e pagamento
        if (/tabela/i.test(message.body)) {
            await safeReply(message, client, configGrupo.tabela);
            return;
        }

        if (/pagamento/i.test(message.body)) {
            await safeReply(message, client, configGrupo.pagamento);
            return;
        }

        // === DETECÇÃO DE PERGUNTA POR NÚMERO (NÃO-ADMIN) ===
        if (!isAdmin && detectarPerguntaPorNumero(message.body)) {
            console.log(`📱 Pergunta por número detectada de não-admin`);
            await message.reply(
                `📱 *Para solicitar número ou suporte:*\n\n` +
                `💳 *Primeiro faça o pagamento:*\n\n` +
                `${configGrupo.pagamento}\n\n` +
                `📝 *Depois envie:*\n` +
                `• Comprovante de pagamento\n` +
                `• Número que vai receber os megas\n\n` +
                `🤖 *Sistema automático 24/7!*`
            );
            return;
        }

        // === VERIFICAR COMANDOS CUSTOMIZADOS ===
        const textoMensagem = message.body.trim().toLowerCase();
        const respostaComando = executarComandoCustomizado(message.from, textoMensagem);

        if (respostaComando) {
            await message.reply(respostaComando);
            console.log(`🎯 Comando customizado '${textoMensagem}' executado no grupo ${message.from}`);
            return;
        }

        // === VERIFICAR GATILHOS AUTOMÁTICOS ===
        const respostaGatilho = verificarGatilhoAutomatico(message.from, message.body);

        if (respostaGatilho) {
            await message.reply(respostaGatilho);
            console.log(`🔔 Gatilho automático acionado no grupo ${message.from}`);
            return;
        }

        // === MONITORAMENTO DE CONFIRMAÇÕES DO BOT SECUNDÁRIO ===
        if (sistemaCompras && message.body.includes('✅') && message.body.includes('Transação Concluída Com Sucesso')) {
            // Extrair referência do padrão: "🔖 *Referência:* CI22H8QJSDQ"
            const regexReferencia = /🔖\s*\*?Referência:\*?\s*([A-Za-z0-9._-]+)/i;
            const matchReferencia = message.body.match(regexReferencia);
            
            // Extrair número do padrão: "📱 *Número:* 842362318"
            const regexNumero = /📱\s*\*?Número:\*?\s*(\d{9})/i;
            const matchNumero = message.body.match(regexNumero);
            
            if (matchReferencia && matchNumero) {
                const referenciaConfirmada = matchReferencia[1]; // Manter case original
                const numeroConfirmado = matchNumero[1];
                console.log(`🛒 CONFIRMAÇÃO BOT: Detectada transação concluída - Ref: ${referenciaConfirmada} | Número: ${numeroConfirmado}`);
                console.log(`🔍 CONFIRMAÇÃO BOT: Tipo detectado: ${/emola|e-mola/i.test(message.body) ? 'EMOLA' : /mpesa|m-pesa/i.test(message.body) ? 'MPESA' : 'DESCONHECIDO'}`);
                
                // Processar confirmação no sistema de compras
                const resultadoConfirmacao = await sistemaCompras.processarConfirmacao(referenciaConfirmada, numeroConfirmado);

                if (resultadoConfirmacao) {
                    console.log(`✅ COMPRAS: Confirmação processada - ${resultadoConfirmacao.numero} | ${resultadoConfirmacao.megas}MB`);

                    // Enviar mensagem de parabenização com menção clicável (igual às boas-vindas)
                    if (resultadoConfirmacao.mensagem && resultadoConfirmacao.contactId) {
                        try {
                            // Normalizar ID para formato @c.us igual às boas-vindas
                            const participantId = resultadoConfirmacao.contactId; // IGUAL ÀS BOAS-VINDAS

                            // VALIDAÇÃO CRÍTICA: Verificar se é um ID válido de usuário
                            const ehIDValido = participantId &&
                                              typeof participantId === 'string' &&
                                              (participantId.includes('@c.us') || participantId.includes('@lid')) &&
                                              !participantId.startsWith('SAQUE_BONUS_') &&
                                              !participantId.startsWith('SAQ');

                            if (!ehIDValido) {
                                console.warn(`⚠️ ID inválido para menção: ${participantId}`);
                                // Usar fallback sem menção
                                throw new Error('ID inválido para menção');
                            }

                            // Usar exato formato das boas-vindas
                            const mensagemFinal = resultadoConfirmacao.mensagem.replace('@NOME_PLACEHOLDER', `@${participantId.replace('@c.us', '').replace('@lid', '')}`);

                            // Enviar com menção igual às boas-vindas
                            await client.sendMessage(message.from, mensagemFinal, {
                                mentions: [participantId]
                            });
                        } catch (error) {
                            console.error('❌ Erro ao enviar parabenização com menção:', error);
                            // Fallback: enviar sem menção clicável
                            const participantId = resultadoConfirmacao.contactId; // IGUAL ÀS BOAS-VINDAS
                            const mensagemFallback = resultadoConfirmacao.mensagem.replace('@NOME_PLACEHOLDER', `@${participantId.replace('@c.us', '').replace('@lid', '')}`);
                            await message.reply(mensagemFallback);
                        }
                    }
                    return; // Confirmação processada com sucesso, sair
                }

                // === SE NÃO ENCONTROU NO SISTEMA DE COMPRAS, VERIFICAR NO CACHE DE DIAMANTES ===
                console.log(`🔍 COMPRAS: Não encontrado em compras normais, verificando cache de pacotes especiais...`);

                // Verificar se é divisão de pacote diamante/.8GB
                const pacoteDiamante = Object.values(pacotesDiamantePendentes).find(
                    p => p.divisoes && p.divisoes.includes(referenciaConfirmada)
                );

                if (pacoteDiamante) {
                    console.log(`💎 PACOTE ESPECIAL: Confirmação de divisão detectada!`);
                    console.log(`💎 Ref Divisão: ${referenciaConfirmada} | Pacote Original: ${pacoteDiamante.referencia}`);
                    console.log(`💎 Tipo: ${pacoteDiamante.tipo || 'diamante'}`);

                    // Adicionar à lista de confirmações recebidas (evitar duplicatas)
                    if (!pacoteDiamante.confirmacoesRecebidas.includes(referenciaConfirmada)) {
                        pacoteDiamante.confirmacoesRecebidas.push(referenciaConfirmada);
                        console.log(`💎 PACOTE ESPECIAL: Confirmação adicionada (${pacoteDiamante.confirmacoesRecebidas.length}/${pacoteDiamante.divisoes.length})`);
                    }

                    // Verificar se TODAS as divisões foram confirmadas
                    if (pacoteDiamante.confirmacoesRecebidas.length === pacoteDiamante.divisoes.length) {
                        // Obter informações do tipo de pacote
                        const codigoPacote = pacoteDiamante.codigoPacote || 1;
                        const tipoPacote = pacoteDiamante.tipo || 'diamante';

                        // Para pacotes .8GB, sempre usar código 2
                        const codigoFinal = tipoPacote === 'pacote_ponto_8gb' ? 2 : codigoPacote;
                        const infoPacote = CODIGOS_PACOTES_ESPECIAIS[codigoFinal];

                        console.log(`${infoPacote.emoji} ${tipoPacote === 'pacote_ponto_8gb' ? 'PACOTE .8GB' : infoPacote.nome}: TODAS as divisões confirmadas! Enviando para planilha...`);

                        // Enviar para planilha de pacotes especiais
                        const resultado = await enviarParaGoogleSheetsDiamante(
                            pacoteDiamante.referencia,
                            pacoteDiamante.numero,
                            codigoFinal,
                            pacoteDiamante.grupoId,
                            pacoteDiamante.grupoNome,
                            'WhatsApp-Bot-Diamante'
                        );

                        if (resultado.sucesso) {
                            console.log(`✅ ${tipoPacote === 'pacote_ponto_8gb' ? 'PACOTE .8GB' : infoPacote.nome}: Pacote ${pacoteDiamante.referencia} enviado com sucesso!`);

                            // Enviar mensagem ao usuário
                            try {
                                let mensagemFinal;
                                if (tipoPacote === 'pacote_ponto_8gb') {
                                    mensagemFinal = `📦 *PACOTE ${pacoteDiamante.totalGB}GB ATIVADO!*\n\n✅ Todos os megas comuns foram confirmados!\n\n📱 Número: ${pacoteDiamante.numero}\n📦 Total: ${pacoteDiamante.totalGB}GB (${pacoteDiamante.gbComuns}GB comuns + ${pacoteDiamante.gb28}GB mensais)\n🔖 Referência: ${pacoteDiamante.referencia}\n\n🎉 Seu pacote completo está sendo ativado agora!`;
                                } else {
                                    mensagemFinal = `${infoPacote.emoji} *${infoPacote.nome.toUpperCase()} ATIVADO!*\n\n✅ Todos os megas extras foram confirmados!\n\n📱 Número: ${pacoteDiamante.numero}\n${infoPacote.emoji} Total: ${pacoteDiamante.totalGB}GB + ${infoPacote.descricao}\n🔖 Referência: ${pacoteDiamante.referencia}\n\n🎉 Seu ${infoPacote.nome.toLowerCase()} completo está sendo ativado agora!`;
                                }
                                await client.sendMessage(message.from, mensagemFinal);
                            } catch (error) {
                                console.error(`❌ Erro ao enviar mensagem de ativação:`, error);
                            }

                            // Remover do cache
                            delete pacotesDiamantePendentes[pacoteDiamante.referencia];
                            console.log(`${tipoPacote === 'pacote_ponto_8gb' ? '📦 PACOTE .8GB' : infoPacote.emoji + ' ' + infoPacote.nome}: Pacote removido do cache de pendentes`);
                        } else {
                            console.error(`❌ ${tipoPacote === 'pacote_ponto_8gb' ? 'PACOTE .8GB' : infoPacote.nome}: Erro ao enviar para planilha: ${resultado.erro}`);
                        }
                    } else {
                        const codigoPacote = pacoteDiamante.codigoPacote || 1;
                        const tipoPacote = pacoteDiamante.tipo || 'diamante';
                        const codigoFinal = tipoPacote === 'pacote_ponto_8gb' ? 2 : codigoPacote;
                        const infoPacote = CODIGOS_PACOTES_ESPECIAIS[codigoFinal];
                        console.log(`⏳ ${tipoPacote === 'pacote_ponto_8gb' ? 'PACOTE .8GB' : infoPacote.nome}: Aguardando mais confirmações (${pacoteDiamante.confirmacoesRecebidas.length}/${pacoteDiamante.divisoes.length})`);
                    }
                    return; // Processado como pacote especial, sair
                }

                // Se não encontrou em nenhum dos dois sistemas
                console.log(`⚠️ CONFIRMAÇÃO: ${referenciaConfirmada} não encontrada em compras nem em pacotes especiais`);
                return;
            }
        }

        // === MONITORAMENTO ADICIONAL PARA PACOTES DIAMANTE ===
        // REMOVIDO: Código duplicado - agora processado no bloco acima (linhas 7493-7568)

        // === PROCESSAMENTO COM IA (LÓGICA SIMPLES IGUAL AO BOT ATACADO) ===
        const remetente = message.author || message.from;
        const resultadoIA = await ia.processarMensagemBot(message.body, remetente, 'texto', configGrupo);
        
        if (resultadoIA.erro) {
            console.error(`❌ Erro na IA:`, resultadoIA.mensagem);
            return;
        }

        if (resultadoIA.sucesso) {

            // === NOVO: TRATAMENTO DE PACOTE .8GB DETECTADO ===
            if (resultadoIA.tipo === 'comprovante_ponto8_detectado') {
                console.log(`📦 PROCESSANDO PACOTE .8GB NO INDEX.JS`);

                const { referencia, valor, numero, pacoteDiamante } = resultadoIA;

                // Verificar configGrupo antes de passar
                console.log(`🔍 configGrupo disponível:`, configGrupo ? `✅ Sim (ID: ${configGrupo.grupoId})` : '❌ Não');

                const comprovante = {
                    referencia: referencia,
                    valor: valor,
                    numero: numero
                };

                const resultadoProcessamento = await processarPacotePonto8(comprovante, configGrupo, pacoteDiamante);

                if (resultadoProcessamento.sucesso) {
                    await message.reply(resultadoProcessamento.mensagem);
                } else {
                    await message.reply(`❌ Erro ao processar pacote .8GB: ${resultadoProcessamento.erro}`);
                }

                return;
            }

            // === NOVO: TRATAMENTO DE PACOTE DIAMANTE DETECTADO ===
            if (resultadoIA.tipo === 'comprovante_diamante_detectado') {
                console.log(`💎 PROCESSANDO PACOTE DIAMANTE NO INDEX.JS`);

                const { referencia, valor, numero, pacoteDiamante } = resultadoIA;

                // Processar pacote diamante
                const resultado = await processarPacoteDiamante(
                    { referencia, valor, numero },
                    { grupoId: message.from, nome: configGrupo.nome, tabela: configGrupo.tabela },
                    pacoteDiamante
                );

                if (resultado.sucesso) {
                    await message.reply(resultado.mensagem);
                } else {
                    await message.reply(
                        `❌ *ERRO AO PROCESSAR PACOTE DIAMANTE*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `⚠️ Erro: ${resultado.erro}\n\n` +
                        `📞 Entre em contato com o suporte.`
                    );
                }
                return;
            }

            if (resultadoIA.tipo === 'comprovante_recebido' || resultadoIA.tipo === 'comprovante_imagem_recebido') {
                const metodoInfo = resultadoIA.metodo ? ` (${resultadoIA.metodo})` : '';
                await message.reply(
                    `✅ *Comprovante processado${metodoInfo}!*\n\n` +
                    `💰 Referência: ${resultadoIA.referencia}\n` +
                    `📊 Megas: ${resultadoIA.megas}\n\n` +
                    `📱 *Envie UM número que vai receber ${resultadoIA.megas}!*`
                );
                return;

            } else if (resultadoIA.tipo === 'numero_processado_com_aviso') {
                const dadosCompletos = resultadoIA.dadosCompletos;
                const [referencia, megas, numero] = dadosCompletos.split('|');
                const nomeContato = message._data.notifyName || 'N/A';
                const autorMensagem = message.author || 'Desconhecido';

                // === VERIFICAÇÃO DE VALOR MUITO BAIXO ===
                if (megas === 'VALOR_MUITO_BAIXO') {
                    console.log(`❌ VALOR MUITO BAIXO: ${referencia} - valor abaixo do pacote mínimo`);

                    const configGrupo = getConfiguracaoGrupo(message.from);
                    const precos = ia.extrairPrecosTabela(configGrupo.tabela);
                    const menorPreco = Math.min(...precos.map(p => p.preco));

                    await message.reply(
                        `❌ *Valor muito baixo*\n\n` +
                        `💳 O valor transferido está abaixo do pacote mínimo disponível.\n\n` +
                        `📋 *Pacote mais barato:* ${menorPreco}MT\n\n` +
                        `💡 *Para ver todos os pacotes:* digite "tabela"`
                    );
                    return;
                }

                // PROCESSAR BÔNUS DE REFERÊNCIA
                const bonusInfo = await processarBonusCompra(remetente, megas, message.from);

                // VERIFICAR PAGAMENTO ANTES DE ENVIAR PARA PLANILHA
                // Usar o valor real do comprovante (não o valor calculado dos megas)
                const valorComprovante = resultadoIA.valorComprovante || megas;
                const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorComprovante);

                // Verificar se pagamento já foi processado
                if (pagamentoConfirmado === 'JA_PROCESSADO') {
                    console.log(`⚠️ REVENDEDORES: Pagamento ${referencia} já foi processado anteriormente!`);
                    await message.reply(
                        `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n\n` +
                        `❌ Este pagamento já foi processado anteriormente.\n` +
                        `📝 Evite enviar o mesmo comprovante múltiplas vezes.\n\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                if (!pagamentoConfirmado) {
                    console.log(`❌ REVENDEDORES: Pagamento não confirmado para texto - ${referencia} (${valorComprovante}MT)`);

                    // Adicionar à fila de retry silencioso
                    await adicionarPagamentoPendente(referencia, valorComprovante, dadosCompletos, message, resultadoIA);

                    await message.reply(
                        `⏳ *AGUARDANDO MENSAGEM DE CONFIRMAÇÃO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n` +
                        `💳 Valor: ${valorComprovante}MT\n\n` +
                        `📨 A mensagem de confirmação ainda não foi recebida no sistema.\n` +
                        `🔄 Verificação automática ativa - você será notificado quando confirmado!\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                console.log(`✅ REVENDEDORES: Pagamento confirmado para texto! Processando...`);

                // === VERIFICAR SE É PACOTE DIAMANTE ===
                const precos = ia.extrairPrecosTabela(configGrupo.tabela);
                const pacoteDiamante = precos.find(p => p.preco === valorComprovante && p.isDiamante === true);

                if (pacoteDiamante) {
                    console.log(`💎 DIAMANTE DETECTADO: ${pacoteDiamante.descricao} (${valorComprovante}MT)`);

                    // Processar pacote diamante
                    const resultado = await processarPacoteDiamante(
                        { referencia, valor: valorComprovante, numero },
                        { grupoId: message.from, nome: configGrupo.nome, tabela: configGrupo.tabela },
                        pacoteDiamante
                    );

                    if (resultado.sucesso) {
                        await message.reply(resultado.mensagem);
                        await marcarPagamentoComoProcessado(referencia, valorComprovante);
                    } else {
                        await message.reply(
                            `❌ *ERRO AO PROCESSAR PACOTE DIAMANTE*\n\n` +
                            `💰 Referência: ${referencia}\n` +
                            `⚠️ Erro: ${resultado.erro}\n\n` +
                            `📞 Entre em contato com o suporte.`
                        );
                    }
                    return; // NÃO enviar para planilha comum
                }

                // Continuar fluxo normal (pedidos comuns)
                const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, message.from, autorMensagem, valorComprovante);

                // Verificar se é pedido duplicado
                if (resultadoEnvio && resultadoEnvio.duplicado) {
                    const statusTexto = resultadoEnvio.status_existente === 'PROCESSADO' ? 'já foi processado' : 'está pendente na fila';
                    await message.reply(
                        `⚠️ *PEDIDO DUPLICADO DETECTADO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n\n` +
                        `❌ Este pedido ${statusTexto}.\n` +
                        `📝 Status: ${resultadoEnvio.status_existente}\n\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                // === MARCAR PAGAMENTO COMO PROCESSADO APÓS ENVIO BEM-SUCEDIDO ===
                if (resultadoEnvio && resultadoEnvio.sucesso) {
                    await marcarPagamentoComoProcessado(referencia, valorComprovante);
                }

                await registrarComprador(message.from, numero, nomeContato, megas);

                // REMOVIDO: Encaminhamento de mensagens (sistema movido para outro bot)

                // Enviar mensagem normal + aviso da tabela
                await message.reply(
                    `✅ *Pedido Recebido!*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 Megas: ${megas} MB\n` +
                    `📱 Número: ${numero}\n\n` +
                    `${resultadoIA.avisoTabela}`
                );
                return;
                
            } else if (resultadoIA.tipo === 'numero_processado') {
                const dadosCompletos = resultadoIA.dadosCompletos;
                const [referencia, megas, numero] = dadosCompletos.split('|');
                const nomeContato = message._data.notifyName || 'N/A';
                const autorMensagem = message.author || 'Desconhecido';

                // === VERIFICAÇÃO DE VALOR MUITO BAIXO ===
                if (megas === 'VALOR_MUITO_BAIXO') {
                    console.log(`❌ VALOR MUITO BAIXO: ${referencia} - valor abaixo do pacote mínimo`);

                    const configGrupo = getConfiguracaoGrupo(message.from);
                    const precos = ia.extrairPrecosTabela(configGrupo.tabela);
                    const menorPreco = Math.min(...precos.map(p => p.preco));

                    await message.reply(
                        `❌ *Valor muito baixo*\n\n` +
                        `💳 O valor transferido está abaixo do pacote mínimo disponível.\n\n` +
                        `📋 *Pacote mais barato:* ${menorPreco}MT\n\n` +
                        `💡 *Para ver todos os pacotes:* digite "tabela"`
                    );
                    return;
                }

                // PROCESSAR BÔNUS DE REFERÊNCIA
                const bonusInfo = await processarBonusCompra(remetente, megas, message.from);

                // VERIFICAR PAGAMENTO ANTES DE ENVIAR PARA PLANILHA
                // Usar o valor real do comprovante (não o valor calculado dos megas)
                const valorComprovante = resultadoIA.valorComprovante || megas;
                const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorComprovante);

                // Verificar se pagamento já foi processado
                if (pagamentoConfirmado === 'JA_PROCESSADO') {
                    console.log(`⚠️ REVENDEDORES: Pagamento ${referencia} já foi processado anteriormente!`);
                    await message.reply(
                        `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n\n` +
                        `❌ Este pagamento já foi processado anteriormente.\n` +
                        `📝 Evite enviar o mesmo comprovante múltiplas vezes.\n\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                if (!pagamentoConfirmado) {
                    console.log(`❌ REVENDEDORES: Pagamento não confirmado para texto - ${referencia} (${valorComprovante}MT)`);

                    // Adicionar à fila de retry silencioso
                    await adicionarPagamentoPendente(referencia, valorComprovante, dadosCompletos, message, resultadoIA);

                    await message.reply(
                        `⏳ *AGUARDANDO MENSAGEM DE CONFIRMAÇÃO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n` +
                        `💳 Valor: ${valorComprovante}MT\n\n` +
                        `📨 A mensagem de confirmação ainda não foi recebida no sistema.\n` +
                        `🔄 Verificação automática ativa - você será notificado quando confirmado!\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                console.log(`✅ REVENDEDORES: Pagamento confirmado para texto! Processando...`);

                // === VERIFICAR SE É PACOTE DIAMANTE ===
                const precos = ia.extrairPrecosTabela(configGrupo.tabela);
                const pacoteDiamante = precos.find(p => p.preco === valorComprovante && p.isDiamante === true);

                if (pacoteDiamante) {
                    console.log(`💎 DIAMANTE DETECTADO: ${pacoteDiamante.descricao} (${valorComprovante}MT)`);

                    // Processar pacote diamante
                    const resultado = await processarPacoteDiamante(
                        { referencia, valor: valorComprovante, numero },
                        { grupoId: message.from, nome: configGrupo.nome, tabela: configGrupo.tabela },
                        pacoteDiamante
                    );

                    if (resultado.sucesso) {
                        await message.reply(resultado.mensagem);
                        await marcarPagamentoComoProcessado(referencia, valorComprovante);
                    } else {
                        await message.reply(
                            `❌ *ERRO AO PROCESSAR PACOTE DIAMANTE*\n\n` +
                            `💰 Referência: ${referencia}\n` +
                            `⚠️ Erro: ${resultado.erro}\n\n` +
                            `📞 Entre em contato com o suporte.`
                        );
                    }
                    return; // NÃO enviar para planilha comum
                }

                // Continuar fluxo normal (pedidos comuns)
                const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, message.from, autorMensagem, valorComprovante);

                // Verificar se é pedido duplicado
                if (resultadoEnvio && resultadoEnvio.duplicado) {
                    const statusTexto = resultadoEnvio.status_existente === 'PROCESSADO' ? 'já foi processado' : 'está pendente na fila';
                    await message.reply(
                        `⚠️ *PEDIDO DUPLICADO DETECTADO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 Megas: ${megas} MB\n` +
                        `📱 Número: ${numero}\n\n` +
                        `❌ Este pedido ${statusTexto}.\n` +
                        `📝 Status: ${resultadoEnvio.status_existente}\n\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                // === MARCAR PAGAMENTO COMO PROCESSADO APÓS ENVIO BEM-SUCEDIDO ===
                if (resultadoEnvio && resultadoEnvio.sucesso) {
                    await marcarPagamentoComoProcessado(referencia, valorComprovante);
                }

                await registrarComprador(message.from, numero, nomeContato, megas);

                // REMOVIDO: Encaminhamento de mensagens (sistema movido para outro bot)

                await message.reply(
                    `✅ *Pedido Recebido!*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 Megas: ${megas}\n` +
                    `📱 Número: ${numero}\n\n` +
                    `_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`
                );
                return;

            } else if (resultadoIA.tipo === 'divisao_blocos') {
                // === PROCESSAR DIVISÃO EM BLOCOS ===
                console.log(`🔧 Processando divisão em blocos...`);

                const dadosCompletos = resultadoIA.dadosCompletos;
                const blocos = dadosCompletos.split('\n');
                const valorComprovante = resultadoIA.valorComprovante;
                const nomeContato = message._data.notifyName || 'N/A';
                const autorMensagem = message.author || 'Desconhecido';

                console.log(`📦 Total de blocos a enviar: ${blocos.length}`);

                // Verificar pagamento antes de processar
                const primeiraLinha = blocos[0].split('|');
                const referenciaOriginal = primeiraLinha[0];

                const pagamentoConfirmado = await verificarPagamentoIndividual(referenciaOriginal, valorComprovante);

                if (pagamentoConfirmado === 'JA_PROCESSADO') {
                    console.log(`⚠️ REVENDEDORES: Pagamento ${referenciaOriginal} já foi processado anteriormente!`);
                    await message.reply(
                        `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n` +
                        `💰 Referência: ${referenciaOriginal}\n` +
                        `📊 Total: ${resultadoIA.megasPorNumero}MB\n` +
                        `📦 Blocos: ${blocos.length}\n\n` +
                        `❌ Este pagamento já foi processado anteriormente.\n\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                if (!pagamentoConfirmado) {
                    console.log(`❌ REVENDEDORES: Pagamento não confirmado para divisão - ${referenciaOriginal} (${valorComprovante}MT)`);
                    await message.reply(
                        `⏳ *AGUARDANDO CONFIRMAÇÃO DE PAGAMENTO*\n\n` +
                        `💰 Referência: ${referenciaOriginal}\n` +
                        `📊 Total: ${resultadoIA.megasPorNumero}MB\n` +
                        `📦 Blocos: ${blocos.length}\n` +
                        `💳 Valor: ${valorComprovante}MT\n\n` +
                        `📨 A mensagem de confirmação ainda não foi recebida no sistema.\n` +
                        `🔄 Verificação automática ativa - você será notificado quando confirmado!\n` +
                        `⏰ ${new Date().toLocaleString('pt-BR')}`
                    );
                    return;
                }

                console.log(`✅ REVENDEDORES: Pagamento confirmado! Enviando ${blocos.length} blocos...`);

                // Enviar cada bloco para a planilha
                let sucessos = 0;
                let falhas = 0;

                for (let i = 0; i < blocos.length; i++) {
                    const bloco = blocos[i];
                    const [refBloco, megasBloco, numeroBloco] = bloco.split('|');

                    console.log(`📤 Enviando bloco ${i + 1}/${blocos.length}: ${refBloco} - ${megasBloco}MB`);

                    const resultadoEnvio = await enviarParaTasker(refBloco, megasBloco, numeroBloco, message.from, autorMensagem, valorComprovante);

                    if (resultadoEnvio && resultadoEnvio.sucesso) {
                        sucessos++;
                    } else if (resultadoEnvio && resultadoEnvio.duplicado) {
                        console.log(`⚠️ Bloco ${refBloco} já existe, continuando...`);
                        sucessos++; // Contar como sucesso se já existe
                    } else {
                        falhas++;
                        console.error(`❌ Falha ao enviar bloco ${refBloco}`);
                    }

                    // Pequeno delay entre envios
                    if (i < blocos.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }

                // Marcar pagamento como processado após todos os blocos
                if (sucessos > 0) {
                    await marcarPagamentoComoProcessado(referenciaOriginal, valorComprovante);
                }

                // Registrar comprador (com megas totais)
                const primeiroNumero = blocos[0].split('|')[2];
                await registrarComprador(message.from, primeiroNumero, nomeContato, resultadoIA.megasPorNumero);

                // Responder ao cliente (mesma mensagem padrão, sem mencionar divisão)
                await message.reply(
                    `✅ *Pedido Recebido!*\n\n` +
                    `💰 Referência: ${referenciaOriginal}\n` +
                    `📊 Megas: ${resultadoIA.megasPorNumero}\n` +
                    `📱 Número: ${primeiroNumero}\n\n` +
                    `_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`
                );

                console.log(`✅ Divisão concluída: ${sucessos} sucessos, ${falhas} falhas`);
                return;
            }
        }

        // === TRATAMENTO DE ERROS ===
        if (resultadoIA.tipo === 'numero_nao_vodacom') {
            console.log(`❌ Número não Vodacom rejeitado: ${resultadoIA.numerosRejeitados?.join(', ')}`);
            await message.reply(resultadoIA.mensagem);
            return;
        }

        if (resultadoIA.tipo === 'numeros_sem_comprovante') {
            await message.reply(
                `📱 *Número detectado*\n\n` +
                `❌ Não encontrei seu comprovante.\n\n` +
                `📝 Envie primeiro o comprovante de pagamento.`
            );
            return;
        }

    } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error);
    }
}

// Novo handler principal com queue
client.on('message', async (message) => {
    try {
        // === FILTRO 1: IGNORAR BOTS (Safe e outros) ===
        const contact = await message.getContact();
        const numeroRemetente = message.author || message.from;

        // Verificar se é bot ignorado
        if (ehBotIgnorado(contact)) {
            const nomeBotIgnorado = contact.pushname || contact.name || 'Bot desconhecido';
            console.log(`🤖 IGNORADO: Mensagem de bot ignorado (${nomeBotIgnorado} - ${numeroRemetente})`);
            return; // Ignora completamente
        }

        // === VERIFICAÇÃO ANTI-DUPLICATAS DE COMPROVANTES (SEGUNDO FILTRO) ===
        const remetente = numeroRemetente;
        const conteudo = message.body || '';

        // Verificar se é COMPROVANTE duplicado (apenas comprovantes são controlados)
        const verificacaoDuplicata = ehComprovanteDuplicado(remetente, conteudo);

        if (verificacaoDuplicata.duplicada) {
            // Comprovante duplicado detectado - responder e sair
            console.log(`🚫 BLOQUEADO: Comprovante duplicado de ${remetente} (enviado há ${verificacaoDuplicata.tempoDecorrido}s)`);

            await message.reply(
                `⚠️ *Comprovante Duplicado*\n\n` +
                `Você já enviou este comprovante há ${verificacaoDuplicata.tempoDecorrido} segundos.\n\n` +
                `✅ Seu pedido já está sendo processado!\n` +
                `🔄 *Não precisa enviar novamente*\n\n` +
                `_Aguarde a confirmação do sistema._`
            );

            return; // Bloqueia processamento
        }

        // Registrar comprovante como processado (se for comprovante)
        registrarComprovanteProcessado(remetente, conteudo);

        // LOG: Verificar se é administrador enviando mensagem em grupo
        if (message.from.endsWith('@g.us')) {
            const autorMensagem = message.author || message.from;
            if (isAdministrador(autorMensagem)) {
                const chat = await message.getChat();
                const nomeGrupo = chat.name || 'Grupo';
                const contato = await message.getContact();
                const nomeAdmin = contato.pushname || contato.name || autorMensagem;
                console.log(`👑 ADMIN DETECTADO: ${nomeAdmin} (${autorMensagem}) enviou mensagem no grupo "${nomeGrupo}"`);
            }
        }

        // PRIMEIRO: Tentar aprender mapeamentos LID automaticamente
        await aprenderMapeamento(message);

        // Registrar primeira mensagem do membro no grupo (se for grupo)
        // REMOVIDO: Registro de primeira mensagem (sistema movido para outro bot)

        // Segundo: tentar processar comandos administrativos rápidos
        const adminProcessed = await handleAdminCommands(message);
        if (adminProcessed) return;

        // Segundo: verificar se precisa ir para fila
        const needsQueue = await handlePurchaseCommands(message);

        if (needsQueue) {
            // Adicionar à fila assíncrona para processamento
            await messageQueue.add(message, processMessage);
        } else {
            // Processar diretamente mensagens simples
            await processMessage(message);
        }

    } catch (error) {
        console.error('❌ Erro no handler principal de mensagem:', error);
    }
});

client.on('disconnected', (reason) => {
    console.log('❌ Bot desconectado:', reason);
});

// Capturar erros não tratados
process.on('unhandledRejection', (reason, promise) => {
    if (reason.message && reason.message.includes('Execution context was destroyed')) {
        console.log('⚠️ Contexto do Puppeteer reiniciado, continuando...');
    } else {
        console.error('❌ Promise rejeitada:', reason);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Erro não capturado:', error.message);
});

// === INICIALIZAÇÃO ===
(async function inicializar() {
    console.log('🚀 Iniciando bot...');
    await carregarComandosCustomizados();
    await carregarGatilhosAutomaticos();
    console.log('🔧 Comandos e gatilhos carregados, inicializando cliente WhatsApp...');
    
    try {
        client.initialize();
        console.log('📱 Cliente WhatsApp inicializado, aguardando conexão...');
    } catch (error) {
        console.error('❌ Erro ao inicializar cliente:', error);
    }
})();

// === APENAS 3 TIMERS ESSENCIAIS (SEGUINDO PADRÃO BOT1) ===

// 1. Salvar histórico a cada 5 minutos (como bot1)
setInterval(salvarHistorico, 5 * 60 * 1000);

// 2. Limpar cache geral a cada hora (como bot1 - simples e eficaz)
setInterval(() => {
    // Limpar cache de transações
    if (cacheTransacoes.size > 200) {
        const keys = Array.from(cacheTransacoes.keys());
        const oldKeys = keys.slice(0, keys.length - 100);
        oldKeys.forEach(key => cacheTransacoes.delete(key));
    }

    // Limpar cache admin seguindo padrão bot1 (similar ao bot1: > 50 = clear)
    if (adminCache.size > 50) {
        adminCache.clear();
    }

    // Limpar outros caches seguindo padrão bot1
    if (gruposLogados && gruposLogados.size > 50) gruposLogados.clear();
    if (membrosProcessadosViaEvent && membrosProcessadosViaEvent.size > 50) membrosProcessadosViaEvent.clear();

    console.log('🗑️ Cache geral limpo');
}, 60 * 60 * 1000); // A cada hora

// 3. Limpar cache de grupos a cada 2 horas (como bot1)
setInterval(() => {
    gruposLogados.clear();
    console.log('🗑️ Cache de grupos detectados limpo');
}, 2 * 60 * 60 * 1000);

process.on('uncaughtException', (error) => {
    console.error('❌ Erro não capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejeitada:', reason);
});

process.on('SIGINT', async () => {
    console.log('\n💾 Salvando dados finais...');

    try {
        // Salvar apenas dados importantes (sem arquivos desnecessários)
        await Promise.allSettled([
            salvarDadosReferencia(),
            salvarHistorico()
        ]);

        console.log('✅ Dados salvos com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao salvar:', error);
    }

    console.log('🧠 IA: ATIVA');
    console.log('📊 API MariaDB: CONFIGURADO');
    console.log(`🔗 URL: ${API_PEDIDOS_CONFIG.scriptUrl}`);
    console.log('🤖 Bot Retalho - Funcionamento otimizado');
    console.log(ia.getStatus());
    process.exit(0);
});









