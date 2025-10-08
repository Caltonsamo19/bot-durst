require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios'); // npm install axios

// === AXIOS SIMPLIFICADO (SEGUINDO PADRÃO BOT1) ===
const axiosInstance = axios.create({
    timeout: 60000, // 60 segundos (aumentado de 30s para evitar timeout em planilhas grandes)
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
                const delayMs = Math.min(1000 * Math.pow(2, tentativa - 1), 10000); // Max 10s
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

// === CONFIGURAÇÃO GOOGLE SHEETS - BOT RETALHO (SCRIPT PRÓPRIO) ===
const GOOGLE_SHEETS_CONFIG = {
    scriptUrl: process.env.GOOGLE_SHEETS_SCRIPT_URL_RETALHO || 'https://script.google.com/macros/s/AKfycbyMilUC5bYKGXV95LR4MmyaRHzMf6WCmXeuztpN0tDpQ9_2qkgCxMipSVqYK_Q6twZG/exec',
    planilhaUrl: 'https://docs.google.com/spreadsheets/d/1vIv1Y0Hiu6NHEG37ubbFoa_vfbEe6sAb9I4JH-P38BQ/edit',
    planilhaId: '1vIv1Y0Hiu6NHEG37ubbFoa_vfbEe6sAb9I4JH-P38BQ',
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 2000
};

// === CONFIGURAÇÃO DE PAGAMENTOS (MESMA PLANILHA DO BOT ATACADO) ===
const PAGAMENTOS_CONFIG = {
    scriptUrl: 'https://script.google.com/macros/s/AKfycbzzifHGu1JXc2etzG3vqK5Jd3ihtULKezUTQQIDJNsr6tXx3CmVmKkOlsld0x1Feo0H/exec',
    timeout: 30000
};

console.log(`📊 Google Sheets configurado`);

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

// === SISTEMA DE PACOTES (será inicializado após WhatsApp conectar) ===
let sistemaPacotes = null;
let sistemaCompras = null;

// Configuração para encaminhamento
const ENCAMINHAMENTO_CONFIG = {
    grupoOrigem: '120363152151047451@g.us', // Phull Megas
    numeroDestino: '258861645968@c.us',
    intervaloSegundos: 2
};

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

// Fila de mensagens para encaminhar (mantida para compatibilidade)
let filaMensagens = [];
let processandoFila = false;

// === SISTEMA DE CACHE DE DADOS OTIMIZADO COM CLEANUP AUTOMÁTICO ===
// === CACHE DE TRANSAÇÕES SIMPLIFICADO (SEGUINDO PADRÃO BOT1) ===
let cacheTransacoes = new Map();

// === SISTEMA DE RETRY SILENCIOSO PARA PAGAMENTOS ===
let pagamentosPendentes = {}; // {id: {dados do pedido}}
let timerRetryPagamentos = null;
const ARQUIVO_PAGAMENTOS_PENDENTES = './pagamentos_pendentes.json';
const RETRY_INTERVAL = 60000; // 60 segundos
const RETRY_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const MAX_RETRY_ATTEMPTS = 3; // Máximo 3 tentativas por pagamento

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
    console.log('🕵️ Iniciando monitoramento automático de novos membros...');
    
    // Executar a cada 2 minutos (otimizado - era 30s)
    setInterval(async () => {
        try {
            await verificarNovosMembros();
        } catch (error) {
            console.error('❌ Erro no monitoramento de membros:', error);
        }
    }, 120000); // 2 minutos
    
    // Primeira execução após 10 segundos (para dar tempo do bot conectar)
    setTimeout(async () => {
        await verificarNovosMembros();
    }, 10000);
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

        // 1. ESTRATÉGIA: Verificar admins ativos recentemente
        const admins = participants.filter(p => p.isAdmin && p.id._serialized !== novoMembroId);

        if (admins.length === 0) {
            console.log(`❌ DETECÇÃO: Nenhum admin encontrado no grupo`);
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
                                    participant.isAdmin) {

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

                        const isAdmin = await isAdminGrupo(grupoId, autorMensagem);
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

        // Filtrar apenas admins
        const admins = participants.filter(p => p.isAdmin);
        if (admins.length === 0) {
            console.log(`❌ Nenhum admin encontrado no grupo`);
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

        codigosReferencia[codigo] = convidadoId;

        console.log(`   ✅ INTELIGENTE: Referência criada: ${codigo} (${nomeConvidador} → ${nomeConvidado})`);

        // Enviar notificação ao convidador com indicação de auto-detecção
        try {
            const mensagemNotificacao = `🤖 *REFERÊNCIA AUTOMÁTICA CRIADA*

🎯 **Código:** ${codigo}
👤 **Novo cliente:** ${nomeConvidado}
📅 **Data:** ${new Date().toLocaleDateString('pt-PT')}

⚠️ *Esta referência foi criada automaticamente*
Se não foi você quem convidou este membro, digite *.cancelar ${codigo}* para cancelar.

💰 Ganhe 10MB por cada 100MT que ele gastar!`;

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

        // Registrar código de referência
        codigosReferencia[codigo] = {
            criador: convidadorId,
            dataCreacao: new Date().toISOString(),
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

        // Salvar dados
        // Sistema de cache otimizado - sem salvamento em arquivos

        // Obter nomes dos participantes para notificação
        const nomeConvidador = await obterNomeContato(convidadorId);
        const nomeConvidado = await obterNomeContato(convidadoId);

        // Enviar notificação no grupo (com indicação de estimativa)
        try {
            await client.sendMessage(grupoId,
                `🎉 *NOVO MEMBRO ADICIONADO!*\n\n` +
                `👋 Bem-vindo @${convidadoId.replace('@c.us', '')}!\n\n` +
                `📢 Sistema detectou provável adição por: @${convidadorId.replace('@c.us', '')}\n` +
                `🎁 @${convidadorId.replace('@c.us', '')} ganhará *200MB* a cada compra de @${convidadoId.replace('@c.us', '')}!\n\n` +
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
        if (!membrosEntrada[grupoId] || !membrosEntrada[grupoId][participantId]) {
            console.log(`⚠️ Membro sem registro de entrada`);
            return false; // Se não tem registro, não é elegível
        }
        
        const dataEntrada = new Date(membrosEntrada[grupoId][participantId]);
        const agora = new Date();
        const limite5Dias = 5 * 24 * 60 * 60 * 1000; // 5 dias em ms
        
        const tempoNoGrupo = agora - dataEntrada;
        const elegivelTempo = tempoNoGrupo <= limite5Dias;
        
        console.log(`🔍 Verificando elegibilidade - ${Math.floor(tempoNoGrupo / (24 * 60 * 60 * 1000))} dias no grupo`);
        
        return elegivelTempo;
    } catch (error) {
        console.error('❌ Erro ao verificar elegibilidade:', error);
        return false;
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
        } catch (e) {
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
    if (salvamentoPendente) return;
    salvamentoPendente = true;

    try {
        // Usar Promise.allSettled para não falhar se um arquivo der erro
        const resultados = await Promise.allSettled([
            fs.writeFile(ARQUIVO_CODIGOS, JSON.stringify(codigosReferencia)),
            fs.writeFile(ARQUIVO_REFERENCIAS, JSON.stringify(referenciasClientes)),
            fs.writeFile(ARQUIVO_BONUS, JSON.stringify(bonusSaldos)),
            fs.writeFile(ARQUIVO_SAQUES, JSON.stringify(pedidosSaque))
        ]);

        // Log apenas se houve falhas
        const falhas = resultados.filter(r => r.status === 'rejected');
        if (falhas.length > 0) {
            console.error('❌ Algumas escritas falharam:', falhas.length);
        }
    } catch (error) {
        console.error('❌ Erro ao salvar dados de referência:', error);
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
async function processarBonusCompra(remetenteCompra, valorCompra) {
    console.log(`🎁 Verificando bônus para compra`);
    
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

        await client.sendMessage(message.from,
            `🎉 *BÔNUS DE REFERÊNCIA CREDITADO!*\n\n` +
            `💎 @${convidador.replace('@c.us', '')}, recebeste *${bonusAtual}MB* de bônus!\n\n` +
            `👤 *Referenciado:* @${remetenteCompra.replace('@c.us', '')}\n` +
            `📢 *Motivo:* @${remetenteCompra.replace('@c.us', '')} que você ${tipoReferencia} fez uma compra!\n` +
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

        // Registrar código de referência
        codigosReferencia[codigo] = {
            criador: convidadorId,
            dataCreacao: new Date().toISOString(),
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

        // Salvar dados
        // Sistema de cache otimizado - sem salvamento em arquivos

        // Obter nomes dos participantes para notificação
        const nomeConvidador = await obterNomeContato(convidadorId);
        const nomeConvidado = await obterNomeContato(convidadoId);

        // Enviar notificação no grupo
        try {
            await client.sendMessage(grupoId,
                `🎉 *NOVO MEMBRO ADICIONADO!*\n\n` +
                `👋 Bem-vindo @${convidadoId.replace('@c.us', '')}!\n\n` +
                `📢 Adicionado por: @${convidadorId.replace('@c.us', '')}\n` +
                `🎁 @${convidadorId.replace('@c.us', '')} ganhará *200MB* a cada compra de @${convidadoId.replace('@c.us', '')}!\n\n` +
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

// === FUNÇÃO PARA VERIFICAR PAGAMENTO ===
async function verificarPagamentoIndividual(referencia, valorEsperado) {
    try {
        const valorNormalizado = normalizarValor(valorEsperado);

        console.log(`🔍 REVENDEDORES: Verificando pagamento ${referencia} - ${valorNormalizado}MT (original: ${valorEsperado})`);

        // Primeira tentativa: busca pelo valor exato (COM RETRY AUTOMÁTICO)
        let response = await axiosComRetry({
            method: 'post',
            url: PAGAMENTOS_CONFIG.scriptUrl,
            data: {
                action: "buscar_por_referencia",
                referencia: referencia,
                valor: valorNormalizado
            },
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        }, 3); // 3 tentativas

        if (response.data && response.data.encontrado) {
            console.log(`✅ REVENDEDORES: Pagamento encontrado (valor exato)!`);
            return true;
        }

        // Segunda tentativa: busca apenas por referência (COM RETRY AUTOMÁTICO)
        console.log(`🔍 REVENDEDORES: Tentando busca apenas por referência...`);
        response = await axiosComRetry({
            method: 'post',
            url: PAGAMENTOS_CONFIG.scriptUrl,
            data: {
                action: "buscar_por_referencia_only",
                referencia: referencia
            },
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        }, 3); // 3 tentativas

        if (response.data && response.data.encontrado) {
            const valorEncontrado = parseFloat(response.data.valor || 0);
            const diferenca = Math.abs(valorEncontrado - valorNormalizado);
            const tolerancia = Math.max(1, valorNormalizado * 0.05); // 5% ou mín 1MT

            console.log(`🔍 REVENDEDORES: Valor encontrado: ${valorEncontrado}MT vs esperado: ${valorNormalizado}MT (diff: ${diferenca.toFixed(2)}MT, tolerância: ${tolerancia.toFixed(2)}MT)`);

            if (diferenca <= tolerancia) {
                console.log(`✅ REVENDEDORES: Pagamento aceito com tolerância!`);
                return true;
            } else {
                console.log(`❌ REVENDEDORES: Diferença muito grande entre valores`);
            }
        }

        console.log(`❌ REVENDEDORES: Pagamento não encontrado`);
        return false;

    } catch (error) {
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

// Base de dados de compradores
let historicoCompradores = {};
const ARQUIVO_HISTORICO = 'historico_compradores.json';

// Cache de administradores dos grupos (diferente do AdminCache global)
let groupAdminCache = {};

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

// Salvar pagamentos pendentes no arquivo
async function salvarPagamentosPendentes() {
    try {
        await fs.writeFile(ARQUIVO_PAGAMENTOS_PENDENTES, JSON.stringify(pagamentosPendentes, null, 2));
        console.log(`💾 RETRY: Pagamentos pendentes salvos - ${Object.keys(pagamentosPendentes).length} pendências`);
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

    for (const pendencia of pendencias) {
        // Verificar se expirou
        if (agora > pendencia.expira) {
            console.log(`⏰ RETRY: Pagamento ${pendencia.referencia} expirou após 30min`);
            await removerPagamentoPendente(pendencia.id);
            continue;
        }

        // Verificar se atingiu limite de tentativas
        if (pendencia.tentativas >= MAX_RETRY_ATTEMPTS) {
            console.log(`❌ RETRY: Pagamento ${pendencia.referencia} atingiu limite de ${MAX_RETRY_ATTEMPTS} tentativas - removendo da fila`);
            await removerPagamentoPendente(pendencia.id);
            continue;
        }

        // Verificar pagamento
        pendencia.tentativas++;
        console.log(`🔍 RETRY: Tentativa ${pendencia.tentativas}/${MAX_RETRY_ATTEMPTS} para ${pendencia.referencia}`);

        const pagamentoConfirmado = await verificarPagamentoIndividual(pendencia.referencia, pendencia.valorComprovante);

        if (pagamentoConfirmado) {
            console.log(`✅ RETRY: Pagamento ${pendencia.referencia} confirmado! Processando...`);
            await processarPagamentoConfirmado(pendencia);
            await removerPagamentoPendente(pendencia.id);
        }
    }

    // Se não há mais pendências, parar timer
    if (Object.keys(pagamentosPendentes).length === 0) {
        pararTimerRetryPagamentos();
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
        const bonusInfo = await processarBonusCompra(chatId, megas);

        // Enviar para Tasker/Planilha
        const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, chatId, messageData.author);

        // Verificar duplicatas
        if (resultadoEnvio && resultadoEnvio.duplicado) {
            await client.sendMessage(chatId,
                `⚠️ *AVISO: PEDIDO DUPLICADO*\n\n` +
                `Este pedido ${resultadoEnvio.status_existente === 'PROCESSADO' ? 'já foi processado' : 'está na fila'}.\n` +
                `Status: ${resultadoEnvio.status_existente}`
            );
            return;
        }

        // Registrar comprador
        await registrarComprador(chatId, numero, messageData.notifyName, megas);

        // Encaminhamento se necessário
        if (chatId === ENCAMINHAMENTO_CONFIG.grupoOrigem) {
            const timestampMensagem = new Date().toLocaleString('pt-BR');
            adicionarNaFila(dadosCompletos, messageData.author, 'Retry Confirmado', timestampMensagem);
        }

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

// Configuração de administradores GLOBAIS
const ADMINISTRADORES_GLOBAIS = [
    '258874100607@c.us',
    '258871112049@c.us',
    '258845356399@c.us',
    '258840326152@c.us',
    '258852118624@c.us',
    '251032533737504@c.us',
    '251032533737504@lid',
    '203109674577958@c.us',
    '203109674577958@lid',
    '23450974470333@lid'   // ID interno do WhatsApp para 852118624
    // Removido temporariamente para testar verificação de grupo: '245075749638206@lid'
];

// Mapeamento de IDs internos (@lid) para números reais (@c.us) - SISTEMA DINÂMICO
let MAPEAMENTO_IDS = {
    '23450974470333@lid': '258852118624@c.us',  // Seu ID
    '245075749638206@lid': null,  // Será identificado automaticamente
    '76991768342659@lid': '258870818180@c.us'  // Joãozinho - corrigido manualmente
};

// === SISTEMA AUTOMÁTICO DE MAPEAMENTO LID ===
const ARQUIVO_MAPEAMENTOS = path.join(__dirname, 'mapeamentos_lid.json');

async function carregarMapeamentos() {
    try {
        if (fs.existsSync(ARQUIVO_MAPEAMENTOS)) {
            const data = await fs.readFile(ARQUIVO_MAPEAMENTOS, 'utf8');
            const mapeamentosSalvos = JSON.parse(data);
            // Mesclar com os mapeamentos base
            MAPEAMENTO_IDS = { ...MAPEAMENTO_IDS, ...mapeamentosSalvos };
            console.log(`✅ Carregados ${Object.keys(mapeamentosSalvos).length} mapeamentos LID salvos`);
        }
    } catch (error) {
        console.error('❌ Erro ao carregar mapeamentos LID:', error.message);
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
    removerUsuario: true,
    excecoes: [
        '258861645968@c.us',
        '258871112049@c.us', 
        '258852118624@c.us'
    ]
};

// Configuração para cada grupo
const CONFIGURACAO_GRUPOS = {
       '258820749141-1441573529@g.us': {
        nome: 'Data Store - Vodacom',
        tabela: `SUPER PROMOÇÃO  DE 🛜ⓂEGAS✅ VODACOM A MELHOR PREÇO DO MERCADO - 04-05/09/2025

📆 PACOTES DIÁRIOS
512MB 💎 10MT 💵💽
900MB 💎 15MT 💵💽
1080MB 💎 17MT 💵💽
1200MB 💎 20MT 💵💽
2150MB 💎 34MT 💵💽
3200MB 💎 51MT 💵💽
4250MB 💎 68MT 💵💽
5350MB 💎 85MT 💵💽
10240MB 💎 160MT 💵💽
20480MB 💎 320MT 💵💽

📅PACOTE DIÁRIO PREMIUM (3 Dias)
2000 + 700MB 💎 44MT 💵💽
3000 + 700MB 💎 66MT 💵💽
4000 + 700MB 💎 88MT 💵💽
5000 + 700MB 💎 109MT 💵💽
6000 + 700MB 💎 133MT 💵💽
7000 + 700MB 💎 149MT 💵💽
10000 + 700MB 💎 219MT 💵💽

📅 PACOTES SEMANAIS(5 Dias)
3072 + 700MB 💎 105MT 💵💽
5120 + 700MB 💎 155MT 💵💽
10240 + 700MB 💎 300MT 💵💽
15360 + 700MB 💎 455MT 💵💽
20480 + 700MB 💎 600MT 💵💽

📅 PACOTES MENSAIS
12.8GB 💎 270MT 💵💽
22.8GB 💎 435MT 💵💽
32.8GB 💎 605MT 💵💽
52.8GB 💎 945MT 💵💽
102.8GB 💎 1605MT 💵💽


PACOTES DIAMANTE MENSAIS
Chamadas + SMS ilimitadas + 11GB 💎 460MT 💵
Chamadas + SMS ilimitadas + 24GB 💎 820MT 💵
Chamadas + SMS ilimitadas + 50GB 💎 1550MT 💵
Chamadas + SMS ilimitadas + 100GB 💎 2250MT 💵

⚠ NB: Válido apenas para Vodacom
`,

        pagamento: `FORMAS DE PAGAMENTO ATUALIZADAS
 
1- M-PESA 
NÚMERO: 848715208
NOME:  NATACHA ALICE

NÚMERO: 871112049
NOME: NATACHA ALICE`
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
        console.log(`📊 Enviando para Google Sheets: ${referencia}`);
        console.log(`🔍 Dados enviados:`, JSON.stringify(dados, null, 2));
        console.log(`🔗 URL destino:`, GOOGLE_SHEETS_CONFIG.scriptUrl);

        // Usar axios COM RETRY para Google Sheets
        const response = await axiosComRetry({
            method: 'post',
            url: GOOGLE_SHEETS_CONFIG.scriptUrl,
            data: dados,
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Source': 'WhatsApp-Bot-Pooled'
            }
        }, 3); // 3 tentativas
        
        // Google Apps Script agora retorna JSON
        const responseData = response.data;
        console.log(`📥 Resposta Google Sheets:`, JSON.stringify(responseData, null, 2));

        // Verificar se é uma resposta JSON válida
        if (typeof responseData === 'object') {
            if (responseData.success) {
                console.log(`✅ Google Sheets: Dados enviados!`);
                return { sucesso: true, referencia: responseData.referencia, duplicado: false };
            } else if (responseData.duplicado) {
                console.log(`⚠️ Google Sheets: Pedido duplicado detectado - ${responseData.referencia} (Status: ${responseData.status_existente})`);
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
                console.log(`✅ Google Sheets: Dados enviados!`);
                return { sucesso: true, row: 'N/A', duplicado: false };
            } else if (responseText.includes('Erro:')) {
                throw new Error(responseText);
            } else {
                throw new Error(`Resposta inesperada: ${responseText}`);
            }
        }
        
    } catch (error) {
        console.error(`❌ Erro Google Sheets [${grupoNome}]: ${error.message}`);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO PRINCIPAL PARA TASKER ===
async function enviarParaTasker(referencia, valor, numero, grupoId, autorMensagem) {
    const grupoNome = getConfiguracaoGrupo(grupoId)?.nome || 'Desconhecido';
    const timestamp = new Date().toLocaleString('pt-BR');
    const linhaCompleta = `${referencia}|${valor}|${numero}`;
    
    console.log(`📊 ENVIANDO PARA GOOGLE SHEETS [${grupoNome}]: ${linhaCompleta}`);
    
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

    // === TENTAR GOOGLE SHEETS PRIMEIRO ===
    const resultado = await enviarParaGoogleSheets(referencia, valor, numero, grupoId, grupoNome, autorMensagem);

    if (resultado.sucesso) {
        // Atualizar cache
        if (cacheTransacoes.has(transacaoKey)) {
            const transacao = cacheTransacoes.get(transacaoKey);
            transacao.enviado = true;
            transacao.metodo = 'google_sheets';
            transacao.row = resultado.row;
        }
        console.log(`✅ [${grupoNome}] Enviado para Google Sheets! Row: ${resultado.row}`);

        // === REGISTRAR COMPRA PENDENTE NO SISTEMA DE COMPRAS ===
        if (sistemaCompras) {
            // Extrair apenas o número do autorMensagem (remover @c.us se houver)
            const numeroRemetente = autorMensagem.replace('@c.us', '');
            console.log(`🔍 DEBUG COMPRA: autorMensagem="${autorMensagem}" | numeroRemetente="${numeroRemetente}" | numero="${numero}"`);
            await sistemaCompras.registrarCompraPendente(referencia, numero, valor, numeroRemetente, grupoId);
        }
    } else if (resultado.duplicado) {
        // Marcar como duplicado no cache
        if (cacheTransacoes.has(transacaoKey)) {
            cacheTransacoes.get(transacaoKey).status = 'duplicado';
        }
        console.log(`🛑 [${grupoNome}] Pedido duplicado detectado: ${referencia}`);

        // Retornar informações do duplicado para o bot processar
        return {
            duplicado: true,
            referencia: resultado.referencia,
            status_existente: resultado.status_existente,
            message: resultado.message
        };
    } else {
        // Fallback para WhatsApp se Google Sheets falhar
        console.log(`🔄 [${grupoNome}] Google Sheets falhou, usando WhatsApp backup...`);
        enviarViaWhatsAppTasker(linhaCompleta, grupoNome, autorMensagem);
        if (cacheTransacoes.has(transacaoKey)) {
            cacheTransacoes.get(transacaoKey).metodo = 'whatsapp_backup';
        }
    }
    
    // === BACKUP REMOVIDO - OTIMIZAÇÃO ===
    // Não salva mais arquivos .txt desnecessários
    
    // Cache já auto-limpa automaticamente
    
    return linhaCompleta;
}

function enviarViaWhatsAppTasker(linhaCompleta, grupoNome, autorMensagem) {
    const item = {
        conteudo: linhaCompleta, // Apenas: referencia|valor|numero
        autor: autorMensagem,
        grupo: grupoNome,
        timestamp: Date.now(),
        id: Date.now() + Math.random(),
        tipo: 'tasker_data_backup'
    };

    filaMensagens.push(item);
    console.log(`📱 WhatsApp Backup → Tasker: ${linhaCompleta}`);

    if (!processandoFila) {
        processarFila();
    }
}

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

async function salvarComandosCustomizados() {
    try {
        await fs.writeFile(ARQUIVO_COMANDOS, JSON.stringify(comandosCustomizados));
        console.log('✅ Comandos customizados salvos');
    } catch (error) {
        console.error('❌ Erro ao salvar comandos:', error);
    }
}

function parsearComandoCustomizado(texto) {
    // Regex para capturar: .addcomando Nome_do_comando(resposta)
    const regex = /^\.addcomando\s+(\w+)\s*\((.+)\)$/s;
    const match = texto.match(regex);
    
    if (match) {
        return {
            nome: match[1].toLowerCase(),
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

function executarComandoCustomizado(chatId, comando) {
    if (comandosCustomizados[chatId] && comandosCustomizados[chatId][comando]) {
        return comandosCustomizados[chatId][comando].resposta;
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
    // Verificar cache primeiro
    const cached = adminCache.get(numero);
    if (cached !== null) {
        return cached;
    }

    // Calcular e cachear resultado
    const isAdmin = ADMINISTRADORES_GLOBAIS.includes(numero);
    adminCache.set(numero, isAdmin);

    return isAdmin;
}

function isGrupoMonitorado(chatId) {
    return CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
}

function getConfiguracaoGrupo(chatId) {
    return CONFIGURACAO_GRUPOS[chatId] || null;
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


async function isAdminGrupo(chatId, participantId) {
    try {
        console.log(`🔍 Verificando admin: chatId=${chatId}, participantId=${participantId}`);
        
        if (groupAdminCache[chatId] && groupAdminCache[chatId].timestamp > Date.now() - 300000) {
            const { admins, mapeamentoLidToCus } = groupAdminCache[chatId];
            console.log(`📋 Usando cache...`);
            
            // Usar mapeamento para verificar se é admin
            const isAdmin = verificarAdminComMapeamento(participantId, admins, mapeamentoLidToCus);
            console.log(`✅ Cache - ${participantId} é admin? ${isAdmin}`);
            return isAdmin;
        }

        console.log(`🔄 Cache expirado/inexistente, buscando admins do grupo...`);
        const chat = await client.getChatById(chatId);
        const participants = await chat.participants;
        const admins = participants.filter(p => p.isAdmin || p.isSuperAdmin);
        
        console.log(`👥 Participantes do grupo: ${participants.length}`);
        // console.log(`👑 Admins (@c.us): ${admins.map(a => a.id._serialized).join(', ')}`);
        
        const participantesLid = participants.filter(p => p.id._serialized.endsWith('@lid'));
        const participantesCus = participants.filter(p => p.id._serialized.endsWith('@c.us'));
        
        console.log(`🔍 Participantes @lid: ${participantesLid.map(p => p.id._serialized).join(', ')}`);
        console.log(`🔍 Participantes @c.us: ${participantesCus.map(p => p.id._serialized).join(', ')}`);
        // console.log(`🎯 Procurando por: ${participantId}`);
        
        // ESTRATÉGIA ADICIONAL: Verificar se o participantId específico tem flag de admin
        let adminDireto = false;
        const participanteEspecifico = participants.find(p => p.id._serialized === participantId);
        if (participanteEspecifico) {
            adminDireto = participanteEspecifico.isAdmin || participanteEspecifico.isSuperAdmin;
            // console.log(`🎯 Participante ${participantId} encontrado! isAdmin: ${participanteEspecifico.isAdmin}, isSuperAdmin: ${participanteEspecifico.isSuperAdmin}`);
        } else {
            console.log(`⚠️ Participante ${participantId} NÃO encontrado na lista de participantes!`);
        }
        
        // CRIAR MAPEAMENTO AUTOMÁTICO
        const mapeamentoLidToCus = criarMapeamentoAutomatico(participants, admins);
        
        // Adicionar detecção direta se encontrada
        if (adminDireto) {
            mapeamentoLidToCus[participantId] = 'ADMIN_DIRETO';
            console.log(`✅ Adicionado ${participantId} como ADMIN_DIRETO no mapeamento!`);
        }
        
        // MAPEAMENTO DIRETO POR NÚMERO: Se o participantId for @lid e houver admin @c.us com mesmo número
        if (participantId.endsWith('@lid')) {
            const numeroBase = participantId.split('@')[0];
            const adminPorNumero = admins.find(admin => {
                return admin.id._serialized.split('@')[0] === numeroBase;
            });
            
            if (adminPorNumero && !mapeamentoLidToCus[participantId]) {
                mapeamentoLidToCus[participantId] = adminPorNumero.id._serialized;
                // console.log(`🎯 MAPEAMENTO DIRETO: ${participantId} -> ${adminPorNumero.id._serialized}`);
            }
        }
        
        console.log(`🗺️ Mapeamento criado:`, mapeamentoLidToCus);
        
        // Salvar cache com mapeamento
        groupAdminCache[chatId] = {
            admins: admins,
            mapeamentoLidToCus: mapeamentoLidToCus,
            timestamp: Date.now()
        };

        // ESTRATÉGIA FINAL: Se não encontrou o participante na lista, tentar abordagem alternativa
        if (!participanteEspecifico && participantId.endsWith('@lid')) {
            console.log(`🔄 Tentativa alternativa: Buscando informações sobre ${participantId}...`);
            try {
                // Tentar obter informações do contato diretamente
                const contact = await client.getContactById(participantId);
                console.log(`📞 Info do contato:`, {
                    id: contact.id._serialized,
                    number: contact.number,
                    pushname: contact.pushname,
                    name: contact.name,
                    isUser: contact.isUser
                });
                
                // ESTRATÉGIA 1: Comparar por número real do contato
                if (contact.number) {
                    console.log(`🔍 Procurando admin com número real: ${contact.number}`);
                    
                    const adminPorNumeroReal = admins.find(admin => {
                        const numeroAdmin = admin.id._serialized.split('@')[0];
                        // Remover código de país e comparar
                        const numeroLimpoAdmin = numeroAdmin.replace(/^258/, '');
                        const numeroLimpoContato = contact.number.replace(/^258/, '').replace(/^/, '');
                        
                        console.log(`   🔍 Comparando "${numeroLimpoContato}" com admin "${numeroLimpoAdmin}"`);
                        return numeroLimpoAdmin === numeroLimpoContato || 
                               numeroAdmin === contact.number ||
                               numeroAdmin.endsWith(contact.number) ||
                               contact.number.endsWith(numeroLimpoAdmin);
                    });
                    
                    if (adminPorNumeroReal) {
                        mapeamentoLidToCus[participantId] = adminPorNumeroReal.id._serialized;
                        console.log(`✅ SUCESSO! Mapeado por número real: ${participantId} -> ${adminPorNumeroReal.id._serialized}`);
                    } else {
                        console.log(`❌ Nenhum admin encontrado com número real ${contact.number}`);
                    }
                }
                
                // ESTRATÉGIA 2: Comparar com admins por número base do ID (fallback)
                if (!mapeamentoLidToCus[participantId]) {
                    const numeroBase = participantId.split('@')[0];
                    console.log(`🔍 Fallback - Procurando admin com número base: ${numeroBase}`);
                    
                    const adminEncontrado = admins.find(admin => {
                        const numeroAdmin = admin.id._serialized.split('@')[0];
                        console.log(`   🔍 Comparando ${numeroBase} com admin ${numeroAdmin}`);
                        return numeroAdmin === numeroBase;
                    });
                    
                    if (adminEncontrado) {
                        mapeamentoLidToCus[participantId] = adminEncontrado.id._serialized;
                        console.log(`✅ SUCESSO! Mapeado por número base: ${participantId} -> ${adminEncontrado.id._serialized}`);
                    } else {
                        console.log(`❌ Nenhum admin encontrado com número ${numeroBase}`);
                        console.log(`📋 Admins disponíveis: ${admins.map(a => a.id._serialized.split('@')[0]).join(', ')}`);
                    }
                }
                
            } catch (err) {
                console.log(`⚠️ Erro ao buscar contato: ${err.message}`);
            }
        }
        
        // Verificar se é admin usando mapeamento
        const isAdmin = verificarAdminComMapeamento(participantId, admins, mapeamentoLidToCus);
        console.log(`✅ Resultado: ${participantId} é admin? ${isAdmin}`);
        return isAdmin;
    } catch (error) {
        console.error('❌ Erro ao verificar admin do grupo:', error);
        return false;
    }
}

// Criar mapeamento automático entre IDs @lid e @c.us
function criarMapeamentoAutomatico(participants, admins) {
    const mapeamento = {};
    
    // Para cada participante @lid, tentar encontrar correspondência com admin @c.us
    const participantesLid = participants.filter(p => p.id._serialized.endsWith('@lid'));
    const adminsIds = admins.map(a => a.id._serialized);
    
    console.log(`🔍 Tentando mapear ${participantesLid.length} IDs @lid para ${adminsIds.length} admins @c.us...`);
    
    // Debug detalhado dos participantes
    if (participantesLid.length === 0) {
        console.log(`⚠️ ATENÇÃO: Nenhum participante @lid encontrado!`);
        console.log(`📋 Todos participantes:`, participants.map(p => ({
            id: p.id._serialized,
            isAdmin: p.isAdmin,
            isSuperAdmin: p.isSuperAdmin,
            pushname: p.pushname
        })));
    }
    
    participantesLid.forEach(participante => {
        const lidId = participante.id._serialized;
        console.log(`🔍 Analisando ${lidId}: isAdmin=${participante.isAdmin}, isSuperAdmin=${participante.isSuperAdmin}, nome=${participante.pushname}`);
        
        // Estratégia 1: Verificar se o próprio participante @lid tem flag de admin
        if (participante.isAdmin || participante.isSuperAdmin) {
            console.log(`✅ ${lidId} tem flag de admin direto!`);
            mapeamento[lidId] = 'ADMIN_DIRETO'; // Marcador especial
            return;
        }
        
        // Estratégia 2: Matching por nome (se disponível)
        if (participante.pushname) {
            const adminCorrespondente = admins.find(admin => 
                admin.pushname && admin.pushname === participante.pushname
            );
            if (adminCorrespondente) {
                mapeamento[lidId] = adminCorrespondente.id._serialized;
                // console.log(`🎯 Mapeado por nome: ${lidId} -> ${adminCorrespondente.id._serialized}`);
                return;
            } else {
                console.log(`❌ Nenhum admin encontrado com nome "${participante.pushname}"`);
            }
        } else {
            console.log(`⚠️ ${lidId} não tem nome disponível para matching`);
        }
    });
    
    return mapeamento;
}

// Verificar se é admin usando o mapeamento
function verificarAdminComMapeamento(participantId, admins, mapeamento) {
    const adminsIds = admins.map(a => a.id._serialized);
    
    // 1. Verificação direta (caso seja @c.us)
    if (adminsIds.includes(participantId)) {
        console.log(`✅ ${participantId} é admin direto (@c.us)`);
        return true;
    }
    
    // 2. Verificação via mapeamento (caso seja @lid)
    if (mapeamento[participantId]) {
        if (mapeamento[participantId] === 'ADMIN_DIRETO') {
            console.log(`✅ ${participantId} é admin direto (@lid com flag)`);
            return true;
        } else if (adminsIds.includes(mapeamento[participantId])) {
            console.log(`✅ ${participantId} mapeado para admin ${mapeamento[participantId]}`);
            return true;
        }
    }
    
    console.log(`❌ ${participantId} não é admin`);
    return false;
}

// Função para verificar se um ID corresponde a um admin
function verificarSeEhAdmin(participantId, admins, todosParticipantes) {
    console.log(`🔍 Procurando ${participantId} entre ${admins.length} admins...`);
    
    // 1. Verificação direta por ID
    const adminDireto = admins.find(admin => admin.id._serialized === participantId);
    if (adminDireto) {
        console.log(`✅ Encontrado por ID direto: ${adminDireto.id._serialized}`);
        return true;
    }
    
    // 2. Para IDs @lid, tentar encontrar correspondência por pushname ou outras características
    if (participantId.endsWith('@lid')) {
        console.log(`🔍 ${participantId} é ID @lid, procurando correspondência...`);
        
        // Buscar o participante pelo ID @lid
        const participante = todosParticipantes.find(p => p.id._serialized === participantId);
        if (participante) {
            console.log(`📱 Participante @lid encontrado:`, {
                id: participante.id._serialized,
                pushname: participante.pushname || 'N/A',
                isAdmin: participante.isAdmin || false,
                isSuperAdmin: participante.isSuperAdmin || false
            });
            
            // VERIFICAÇÃO DIRETA: Se o próprio participante @lid tem flag de admin
            if (participante.isAdmin || participante.isSuperAdmin) {
                console.log(`✅ O próprio participante @lid TEM flag de admin!`);
                return true;
            }
            
            // Verificar se existe admin com mesmo pushname ou número base
            const adminCorrespondente = admins.find(admin => {
                // Tentar matching por pushname se disponível
                if (participante.pushname && admin.pushname && 
                    participante.pushname === admin.pushname) {
                    return true;
                }
                return false;
            });
            
            if (adminCorrespondente) {
                console.log(`✅ Encontrado admin correspondente por pushname: ${adminCorrespondente.id._serialized}`);
                return true;
            }
        } else {
            console.log(`❌ Participante @lid ${participantId} não encontrado na lista de participantes`);
        }
    }
    
    console.log(`❌ ${participantId} não é admin do grupo`);
    return false;
}

function contemConteudoSuspeito(mensagem) {
    const texto = mensagem.toLowerCase();
    const temLink = /(?:https?:\/\/|www\.|\.com|\.net|\.org|\.br|\.mz|bit\.ly|tinyurl|t\.me|wa\.me|whatsapp\.com|telegram\.me|link|url)/i.test(texto);
    
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
        if (!MODERACAO_CONFIG.ativado[chatId]) {
            return;
        }

        if (MODERACAO_CONFIG.excecoes.includes(authorId) || isAdministrador(authorId)) {
            return;
        }

        const isAdmin = await isAdminGrupo(chatId, authorId);
        if (isAdmin) {
            return;
        }

        console.log(`🚨 MODERAÇÃO: ${motivoDeteccao}`);

        if (MODERACAO_CONFIG.apagarMensagem) {
            await deletarMensagem(message);
        }

        if (MODERACAO_CONFIG.removerUsuario) {
            await removerParticipante(chatId, authorId, motivoDeteccao);
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
    console.log(`💰 Comprador registrado: ${nomeContato} (${numeroComprador}) - ${valorTransferencia}MT`);
}

// === FILA DE MENSAGENS ===

function adicionarNaFila(mensagem, autor, nomeGrupo, timestamp) {
    const item = {
        conteudo: mensagem,
        autor: autor,
        grupo: nomeGrupo,
        timestamp: timestamp,
        id: Date.now() + Math.random()
    };

    filaMensagens.push(item);
    console.log(`📥 Adicionado à fila: ${filaMensagens.length} mensagens`);

    if (!processandoFila) {
        processarFila();
    }
}

async function processarFila() {
    if (processandoFila || filaMensagens.length === 0) {
        return;
    }

    processandoFila = true;
    console.log(`🚀 Processando ${filaMensagens.length} mensagens...`);

    while (filaMensagens.length > 0) {
        const item = filaMensagens.shift();

        try {
            await client.sendMessage(ENCAMINHAMENTO_CONFIG.numeroDestino, item.conteudo);
            console.log(`✅ Encaminhado: ${item.conteudo.substring(0, 50)}...`);

            if (filaMensagens.length > 0) {
                await new Promise(resolve => setTimeout(resolve, ENCAMINHAMENTO_CONFIG.intervaloSegundos * 1000));
            }

        } catch (error) {
            console.error(`❌ Erro ao encaminhar:`, error);
            filaMensagens.unshift(item);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    processandoFila = false;
    console.log(`🎉 Fila processada!`);
}

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
    console.log('📊 Google Sheets configurado!');
    console.log(`🔗 URL: ${GOOGLE_SHEETS_CONFIG.scriptUrl}`);
    console.log('🤖 Bot Retalho - Lógica simples igual ao Bot Atacado!');

    // Carregar mapeamentos LID salvos
    await carregarMapeamentos();

    // === INICIALIZAR SISTEMA DE RELATÓRIOS ===
    try {
        global.sistemaRelatorios = new SistemaRelatorios(client, GOOGLE_SHEETS_CONFIG, PAGAMENTOS_CONFIG);

        // Configurar números de relatório (AJUSTAR CONFORME NECESSÁRIO)
        // sistemaRelatorios.configurarNumeroRelatorio('GRUPO_ID_AQUI', '258847123456');

        // Iniciar agendamento às 22h
        global.sistemaRelatorios.iniciarAgendamento();

        console.log('📊 Sistema de relatórios iniciado!');
        console.log('⏰ Relatórios agendados para 22:00 diariamente');
        console.log('📞 Configure números com: !config-relatorio');

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
    
    // Carregar dados de referência
    await carregarDadosReferencia();
    
    await carregarHistorico();
    
    console.log('\n🤖 Monitorando grupos:');
    Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
        const config = CONFIGURACAO_GRUPOS[grupoId];
        console.log(`   📋 ${config.nome} (${grupoId})`);
    });
    
    console.log('\n🔧 Comandos admin: .ia .stats .sheets .test_sheets .test_grupo .grupos_status .grupos .grupo_atual .addcomando .comandos .delcomando .test_vision .ranking .inativos .semcompra .resetranking .bonus .testreferencia .config-relatorio .list-relatorios .remove-relatorio .test-relatorio');
    
    // Iniciar monitoramento automático de novos membros
    await iniciarMonitoramentoMembros();
});

client.on('group-join', async (notification) => {
    try {
        console.log('🔍 EVENT group-join disparado!');
        console.log('📊 Tipo de notificação:', notification.type); // 'add' ou 'invite'
        console.log('⏰ Timestamp:', new Date(notification.timestamp * 1000));

        const chatId = notification.chatId;
        const addedParticipants = notification.recipientIds || [];
        const addedBy = notification.author; // QUEM ADICIONOU OS NOVOS MEMBROS
        const botInfo = client.info;

        console.log(`📍 ChatId: ${chatId}`);
        console.log(`👥 Participantes adicionados: ${addedParticipants.join(', ')}`);
        console.log(`👤 Adicionado por (ID): ${addedBy || 'INDEFINIDO'}`);

        // USAR MÉTODOS DA DOCUMENTAÇÃO PARA OBTER DETALHES REAIS
        let nomeAdicionador = 'INDEFINIDO';
        let nomesAdicionados = [];

        try {
            // Obter detalhes de quem adicionou
            if (addedBy) {
                const contact = await notification.getContact();
                nomeAdicionador = contact.pushname || contact.name || addedBy;
                console.log(`👤 Adicionado por (Nome Real): ${nomeAdicionador}`);
            }

            // Obter detalhes de quem foi adicionado
            const recipients = await notification.getRecipients();
            nomesAdicionados = recipients.map(r => r.pushname || r.name || r.id._serialized);
            console.log(`👥 Novos membros (Nomes): ${nomesAdicionados.join(', ')}`);

            // Obter detalhes do grupo
            const chat = await notification.getChat();
            console.log(`🏢 Grupo: ${chat.name}`);

        } catch (error) {
            console.log(`⚠️ Erro ao obter detalhes dos contatos:`, error.message);
        }

        console.log(`🤖 Bot ID: ${botInfo?.wid?._serialized || 'INDEFINIDO'}`);

        if (botInfo && addedParticipants.includes(botInfo.wid._serialized)) {
            console.log(`\n🤖 BOT ADICIONADO A UM NOVO GRUPO!`);
            await logGrupoInfo(chatId, 'BOT ADICIONADO');

            setTimeout(async () => {
                try {
                    const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
                    const mensagem = isMonitorado ?
                        `🤖 *BOT ATIVO E CONFIGURADO!*\n\nEste grupo está monitorado e o sistema automático já está funcionando.\n\n📋 Digite: *tabela* (ver preços)\n💳 Digite: *pagamento* (ver formas)` :
                        `🤖 *BOT CONECTADO!*\n\n⚙️ Este grupo ainda não está configurado.\n🔧 Contacte o administrador para ativação.\n\n📝 ID do grupo copiado no console do servidor.`;

                    await client.sendMessage(chatId, mensagem);
                    console.log(`✅ Mensagem de status enviada`);
                } catch (error) {
                    console.error('❌ Erro ao enviar mensagem de status:', error);
                }
            }, 3000);
        } else {
            // NOVOS MEMBROS (NÃO-BOT) ENTRARAM NO GRUPO
            console.log('👥 Processando novos membros...');

            const configGrupo = getConfiguracaoGrupo(chatId);
            console.log(`🏢 Grupo configurado: ${configGrupo ? configGrupo.nome : 'NÃO CONFIGURADO'}`);
            console.log(`👤 Adicionado por: ${addedBy || 'INDEFINIDO'}`);

            if (configGrupo && addedBy) {
                console.log(`✅ Condições atendidas! Processando ${addedParticipants.length} membro(s)...`);
                console.log(`📝 Tipo de adição: ${notification.type} (add=admin adicionou, invite=entrou via link)`);

                // Processar cada novo membro
                for (let i = 0; i < addedParticipants.length; i++) {
                    const participantId = addedParticipants[i];
                    const nomeParticipante = nomesAdicionados[i] || participantId;

                    try {
                        console.log(`👋 PROCESSANDO VIA EVENT: ${nomeParticipante} (${participantId})`);
                        console.log(`👤 Adicionado por: ${nomeAdicionador} (${addedBy})`);
                        console.log(`🏢 No grupo: ${configGrupo.nome}`);

                        // Marcar como processado via event para evitar processamento duplicado
                        const membroKey = `${chatId}_${participantId}`;
                        membrosProcessadosViaEvent.add(membroKey);

                        // SISTEMA AUTOMÁTICO DESATIVADO - Novo membro deve usar código manual
                        console.log(`📢 Sistema automático desativado - ${nomeParticipante} deve usar código do convidador`);

                        /* SISTEMA AUTOMÁTICO COMENTADO - USUÁRIO PREFERIU MÉTODO MANUAL
                        if (notification.type === 'add') {
                            console.log(`🔗 Criando referência automática (admin adicionou)...`);
                            const resultado = await criarReferenciaAutomatica(addedBy, participantId, chatId);
                            console.log(`🔗 Resultado da criação: ${resultado ? 'SUCESSO' : 'FALHOU'}`);
                        } else if (notification.type === 'invite') {
                            console.log(`📎 Membro entrou via link de convite - não criando referência automática`);
                        } else {
                            console.log(`❓ Tipo de entrada desconhecido: ${notification.type}`);
                        }
                        */

                    } catch (error) {
                        console.error(`❌ Erro ao processar novo membro ${participantId}:`, error);
                        console.error(`❌ Stack trace:`, error.stack);
                    }
                }
            } else {
                if (!configGrupo) {
                    console.log(`❌ Grupo ${chatId} não está configurado no sistema`);
                }
                if (!addedBy) {
                    console.log(`❌ Não foi possível identificar quem adicionou os membros`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro no evento group-join:', error);
    }
});

// === HANDLERS SEPARADOS POR TIPO DE COMANDO ===
async function handleAdminCommands(message) {
    const autorMensagem = message.author || message.from;
    const isAdmin = isAdministrador(autorMensagem);

    let isAdminDoGrupo = false;
    if (message.from.endsWith('@g.us')) {
        isAdminDoGrupo = await isAdminGrupo(message.from, autorMensagem);
    }

    const isAdminQualquer = isAdmin || isAdminDoGrupo;
    if (!isAdminQualquer) return false;

    const comando = message.body.toLowerCase().trim();

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
        if (message.body.startsWith('.addcomando') || message.body.startsWith('.comandos') || message.body.startsWith('.delcomando')) {
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
        // Verificar se é admin global OU admin do grupo
        let isAdminDoGrupo = false;
        
        // Só verificar admin do grupo se for mensagem de grupo
        if (message.from.endsWith('@g.us')) {
            isAdminDoGrupo = await isAdminGrupo(message.from, autorMensagem);
            smartLog(LOG_LEVEL.DEBUG, `🔍 Debug admin grupo: ${autorMensagem} é admin do grupo? ${isAdminDoGrupo}`);
        }
        
        const isAdminQualquer = isAdmin || isAdminDoGrupo;
        smartLog(LOG_LEVEL.DEBUG, `🔍 Debug final: isAdminQualquer = ${isAdminQualquer} (global: ${isAdmin}, grupo: ${isAdminDoGrupo})`);
        
        if (isAdminQualquer) {
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
                            await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato correto:**\n*.pacote DIAS REF NUMERO*\n\n📝 **Exemplos:**\n• *.pacote 3 ABC123 845123456*\n• *.pacote 30 XYZ789 847654321*\n\n📦 **Tipos disponíveis:**\n• 3 - Pacote de 3 dias (300MB)\n• 5 - Pacote de 5 dias (500MB)\n• 15 - Pacote de 15 dias (1.5GB)\n• 30 - Pacote de 30 dias (3GB)`);
                            return;
                        }

                        const [, diasPacote, referencia, numero] = partes;
                        const grupoId = message.from;

                        console.log(`📦 COMANDO PACOTE: Dias=${diasPacote}, Ref=${referencia}, Numero=${numero}`);

                        const resultado = await sistemaPacotes.processarComprovante(referencia, numero, grupoId, diasPacote);

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
                        await message.reply(`❌ *USO INCORRETO*\n\n✅ **Formato correto:**\n*.validade NUMERO*\n\n📝 **Exemplo:**\n• *.validade 845123456*\n\n💡 Digite seu número para verificar a validade do seu pacote de 100MB diários.`);
                        return;
                    }
                    
                    const numero = partes[1];
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
                        
                        if (ranking.length === 0) {
                            await message.reply(`📊 *RANKING DE COMPRADORES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🚫 Nenhum comprador registrado hoje.`);
                            return;
                        }
                        
                        let mensagem = `📊 *RANKING DE COMPRADORES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                        let mentions = [];
                        
                        for (let i = 0; i < ranking.length; i++) {
                            const item = ranking[i];
                            // COPIAR EXATAMENTE A LÓGICA DAS BOAS-VINDAS - SEM CONVERSÃO
                            const participantId = item.numero; // Usar número exatamente como está salvo

                            // Obter informações do contato
                            try {
                                const contact = await client.getContactById(participantId);

                                // Prioridade: nome salvo > nome do perfil > número
                                const nomeExibicao = contact.name || contact.pushname || item.numero;

                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${item.posicao}º`;
                                const megasFormatados = item.megas >= 1024 ?
                                    `${(item.megas/1024).toFixed(1)}GB` : `${item.megas}MB`;

                                // Usar exatamente o mesmo padrão das boas-vindas
                                mensagem += `${posicaoEmoji} @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   💾 ${megasFormatados} no grupo (${item.compras}x)\n`;
                                mensagem += `   📊 Total: ${item.megasTotal >= 1024 ? (item.megasTotal/1024).toFixed(1)+'GB' : item.megasTotal+'MB'}\n\n`;

                                mentions.push(participantId);
                            } catch (error) {
                                // Se não conseguir obter o contato, usar apenas o número com padrão das boas-vindas
                                const posicaoEmoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${item.posicao}º`;
                                const megasFormatados = item.megas >= 1024 ?
                                    `${(item.megas/1024).toFixed(1)}GB` : `${item.megas}MB`;

                                // Usar exatamente o mesmo padrão das boas-vindas
                                mensagem += `${posicaoEmoji} @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   💾 ${megasFormatados} no grupo (${item.compras}x)\n`;
                                mensagem += `   📊 Total: ${item.megasTotal >= 1024 ? (item.megasTotal/1024).toFixed(1)+'GB' : item.megasTotal+'MB'}\n\n`;

                                mentions.push(participantId);
                            }
                        }
                        
                        mensagem += `🏆 *Total de compradores no grupo: ${ranking.length}*`;
                        
                        await client.sendMessage(message.from, mensagem, { mentions: mentions });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter ranking:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter o ranking de compradores.\n\n⚠️ Erro: ${error.message}`);
                        return;
                    }
                }
                
                // .inativos - Mostrar compradores inativos (mais de 10 dias sem comprar)
                if (comando === '.inativos') {
                    try {
                        const inativos = await sistemaCompras.obterInativos();
                        
                        if (inativos.length === 0) {
                            await message.reply(`😴 *COMPRADORES INATIVOS*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🎉 Todos os compradores estão ativos!\nNinguém está há mais de 10 dias sem comprar.`);
                            return;
                        }
                        
                        let mensagem = `😴 *COMPRADORES INATIVOS*\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
                        mensagem += `⏰ Mais de 10 dias sem comprar\n\n`;
                        let mentions = [];
                        
                        for (let i = 0; i < Math.min(inativos.length, 20); i++) {
                            const item = inativos[i];
                            // COPIAR EXATAMENTE A LÓGICA DAS BOAS-VINDAS - SEM CONVERSÃO
                            const participantId = item.numero; // Usar número exatamente como está salvo

                            // Obter informações do contato
                            try {
                                const contact = await client.getContactById(participantId);
                                
                                // Prioridade: nome salvo > nome do perfil > número
                                const nomeExibicao = contact.name || contact.pushname || item.numero;
                                const numeroLimpo = contact.id.user; // Número sem @ e sem +
                                
                                const totalFormatado = item.megasTotal >= 1024 ? 
                                    `${(item.megasTotal/1024).toFixed(1)}GB` : `${item.megasTotal}MB`;
                                
                                mensagem += `👤 @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   ⏰ ${item.diasSemComprar} dias sem comprar\n`;
                                mensagem += `   📊 Total: ${item.totalCompras}x compras (${totalFormatado})\n\n`;
                                
                                mentions.push(participantId);
                            } catch (error) {
                                // Se não conseguir obter o contato, usar apenas o número
                                const totalFormatado = item.megasTotal >= 1024 ? 
                                    `${(item.megasTotal/1024).toFixed(1)}GB` : `${item.megasTotal}MB`;
                                
                                mensagem += `👤 @${participantId.replace('@c.us', '')}\n`;
                                mensagem += `   ⏰ ${item.diasSemComprar} dias sem comprar\n`;
                                mensagem += `   📊 Total: ${item.totalCompras}x compras (${totalFormatado})\n\n`;
                                
                                mentions.push(participantId);
                            }
                        }
                        
                        if (inativos.length > 20) {
                            mensagem += `... e mais ${inativos.length - 20} compradores inativos\n\n`;
                        }
                        
                        mensagem += `😴 *Total de inativos: ${inativos.length}*`;
                        
                        await client.sendMessage(message.from, mensagem, { mentions: mentions });
                        return;
                    } catch (error) {
                        console.error('❌ Erro ao obter inativos:', error);
                        await message.reply(`❌ *ERRO*\n\nNão foi possível obter a lista de inativos.\n\n⚠️ Erro: ${error.message}`);
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
                        
                        await client.sendMessage(message.from, mensagem, { mentions: mentions });
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

                        // Verificar permissão de admin
                        const admins = ['258861645968', '258123456789', '258852118624', '23450974470333', '251032533737504', '203109674577958']; // Lista de admins
                        const numeroAdmin = autorMensagem.replace('@c.us', '').replace('@lid', '');
                        console.log(`🔑 Número admin processado: ${numeroAdmin}`);
                        console.log(`📋 Admins permitidos: ${admins.join(', ')}`);

                        if (!admins.includes(numeroAdmin)) {
                            console.log(`❌ Admin NÃO autorizado`);
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

                        // Verificar se é menção ou número direto
                        if (numeroDestino.startsWith('@')) {
                            console.log(`🔍 Detectada menção (@)`);
                            // Remover @ e verificar se tem menções na mensagem
                            const numeroMencao = numeroDestino.substring(1);
                            if (message.mentionedIds && message.mentionedIds.length > 0) {
                                console.log(`✅ Menções encontradas: ${message.mentionedIds.join(', ')}`);
                                // Usar a primeira menção encontrada
                                const mencaoId = message.mentionedIds[0];
                                numeroDestino = mencaoId.replace('@c.us', '');
                                console.log(`📱 Número extraído da menção: ${numeroDestino}`);
                            } else {
                                console.log(`⚠️ Nenhuma menção encontrada, usando número após @`);
                                // Tentar usar o número após @
                                numeroDestino = numeroMencao;
                            }
                        }

                        console.log(`🔎 Validando número: "${numeroDestino}"`);
                        console.log(`   - Tem 9 dígitos? ${/^\d{9}$/.test(numeroDestino)}`);
                        console.log(`   - Tem 12 dígitos? ${/^\d{12}$/.test(numeroDestino)}`);

                        // Validar número - aceitar 9 dígitos (848715208) ou 12 dígitos (258848715208)
                        if (!/^\d{9}$/.test(numeroDestino) && !/^\d{12}$/.test(numeroDestino)) {
                            console.log(`❌ Número INVÁLIDO: ${numeroDestino}`);
                            await message.reply(`❌ *NÚMERO INVÁLIDO*\n\n✅ Use formato:\n• *.bonus @848715208 500MB* (9 dígitos)\n• *.bonus @258848715208 500MB* (12 dígitos)\n• *.bonus 848715208 500MB* (número direto)`);
                            return;
                        }

                        console.log(`✅ Número válido`);

                        // Converter para formato completo se necessário (adicionar 258 no início)
                        if (numeroDestino.length === 9) {
                            numeroDestino = '258' + numeroDestino;
                            console.log(`🔄 Convertido para 12 dígitos: ${numeroDestino}`);
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

                        // IMPORTANTE: Salvar com AMBOS os formatos (@c.us e @lid) para compatibilidade total
                        const participantIdCus = `${numeroDestino}@c.us`;
                        const participantIdLid = `${numeroDestino}@lid`;
                        console.log(`🎯 Salvando em ambos formatos:`);
                        console.log(`   - @c.us: ${participantIdCus}`);
                        console.log(`   - @lid: ${participantIdLid}`);

                        // Inicializar saldo para AMBOS os formatos (para garantir compatibilidade)
                        for (const participantId of [participantIdCus, participantIdLid]) {
                            if (!bonusSaldos[participantId]) {
                                console.log(`🆕 Criando novo registro de bônus para ${participantId}`);
                                bonusSaldos[participantId] = {
                                    saldo: 0,
                                    detalhesReferencias: {},
                                    historicoSaques: [],
                                    totalReferencias: 0,
                                    bonusAdmin: []
                                };
                            } else {
                                console.log(`✅ Registro existente encontrado para ${participantId} (saldo: ${bonusSaldos[participantId].saldo}MB)`);
                            }
                        }

                        // Adicionar bônus em AMBOS os formatos (sincronizados)
                        let saldoAnterior = 0;
                        for (const participantId of [participantIdCus, participantIdLid]) {
                            saldoAnterior = bonusSaldos[participantId].saldo;
                            bonusSaldos[participantId].saldo += quantidadeMB;

                            // Registrar histórico de bônus admin
                            if (!bonusSaldos[participantId].bonusAdmin) {
                                bonusSaldos[participantId].bonusAdmin = [];
                            }

                            bonusSaldos[participantId].bonusAdmin.push({
                                quantidade: quantidadeMB,
                                data: new Date().toISOString(),
                                admin: autorMensagem,
                                motivo: 'Bônus administrativo'
                            });
                        }

                        console.log(`💰 Saldo atualizado em ambos formatos: ${saldoAnterior}MB → ${bonusSaldos[participantIdCus].saldo}MB (+${quantidadeMB}MB)`);
                        console.log(`📝 Histórico de bônus admin atualizado (${bonusSaldos[participantIdCus].bonusAdmin.length} registros)`);

                        // Usar @c.us como principal para referência
                        const participantId = participantIdCus;

                        // Salvar dados após conceder bônus
                        agendarSalvamento();

                        const quantidadeFormatada = quantidadeMB >= 1024 ? `${(quantidadeMB/1024).toFixed(2)}GB` : `${quantidadeMB}MB`;
                        const novoSaldo = bonusSaldos[participantId].saldo;
                        const novoSaldoFormatado = novoSaldo >= 1024 ? `${(novoSaldo/1024).toFixed(2)}GB` : `${novoSaldo}MB`;

                        console.log(`🎁 ADMIN BONUS CONCEDIDO: ${autorMensagem} → ${numeroDestino} (+${quantidadeFormatada})`);

                        // Notificar o usuário que recebeu o bônus (USANDO EXATAMENTE O PADRÃO DAS CONFIRMAÇÕES DE COMPRA)
                        const mensagemBonus = `🎁 *BÔNUS ADMINISTRATIVO!*\n\n` +
                            `💎 @NOME_PLACEHOLDER, recebeste *${quantidadeFormatada}* de bônus!\n\n` +
                            `👨‍💼 *Ofertado por:* Administrador\n` +
                            `💰 *Novo saldo:* ${novoSaldoFormatado}\n\n` +
                            `${novoSaldo >= 1024 ? '🚀 *Já podes sacar!* Use: *.sacar*' : '💡 *Continua a acumular para sacar!*'}`;

                        try {
                            // Garantir que participantId tem @c.us para menção funcionar
                            const contactIdMencao = participantId.includes('@c.us') ? participantId : `${participantId}@c.us`;

                            // COPIAR EXATAMENTE O PADRÃO DAS CONFIRMAÇÕES (linha 5081)
                            const mensagemFinal = mensagemBonus.replace('@NOME_PLACEHOLDER', `@${participantId.replace('@c.us', '').replace('@lid', '')}`);

                            // Enviar com menção igual às confirmações de compra (linha 5084-5086)
                            await client.sendMessage(message.from, mensagemFinal, {
                                mentions: [contactIdMencao]
                            });
                        } catch (notificationError) {
                            console.error('❌ Erro ao enviar notificação de bônus admin:', notificationError);
                            // Fallback: enviar sem menção (igual às confirmações linha 5091-5092)
                            const mensagemFallback = mensagemBonus.replace('@NOME_PLACEHOLDER', `@${participantId.replace('@c.us', '').replace('@lid', '')}`);
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

                // === COMANDOS DE RELATÓRIOS ===

                // .config-relatorio GRUPO_ID NUMERO - Configurar número para relatórios (ADMIN APENAS)
                if (comando.startsWith('.config-relatorio ')) {
                    if (!isAdmin) {
                        await message.reply('❌ Apenas administradores podem usar este comando!');
                        return;
                    }

                    const parametros = comando.split(' ');
                    if (parametros.length < 3) {
                        await message.reply(
                            `❌ *FORMATO INCORRETO*\n\n` +
                            `✅ Use: *.config-relatorio GRUPO_ID NUMERO*\n\n` +
                            `📋 **Exemplos:**\n` +
                            `• *.config-relatorio 258820749141-1441573529@g.us 258847123456*\n\n` +
                            `💡 **Para obter ID do grupo:**\n` +
                            `Use: *.grupo_atual*`
                        );
                        return;
                    }

                    const grupoId = parametros[1];
                    let numeroRelatorio = parametros[2];

                    // Validar número
                    if (!/^\d{9}$/.test(numeroRelatorio) && !/^\d{12}$/.test(numeroRelatorio)) {
                        await message.reply(
                            `❌ *NÚMERO INVÁLIDO*\n\n` +
                            `✅ Use formato de 9 ou 12 dígitos:\n` +
                            `• 847123456 (9 dígitos)\n` +
                            `• 258847123456 (12 dígitos)`
                        );
                        return;
                    }

                    // Converter para formato completo se necessário
                    if (numeroRelatorio.length === 9) {
                        numeroRelatorio = '258' + numeroRelatorio;
                    }

                    // Configurar no sistema de relatórios
                    if (global.sistemaRelatorios) {
                        global.sistemaRelatorios.configurarNumeroRelatorio(grupoId, numeroRelatorio);

                        await message.reply(
                            `✅ *CONFIGURAÇÃO SALVA*\n\n` +
                            `📱 Grupo: ${grupoId.split('@')[0]}\n` +
                            `📞 Número para relatórios: ${numeroRelatorio}\n` +
                            `⏰ Relatórios às 22:00 diariamente\n\n` +
                            `💡 Teste com: *.test-relatorio*`
                        );
                    } else {
                        await message.reply('❌ Sistema de relatórios não está disponível');
                    }
                    return;
                }

                // .list-relatorios - Listar configurações de relatórios (ADMIN APENAS)
                if (comando === '.list-relatorios') {
                    if (!isAdmin) {
                        await message.reply('❌ Apenas administradores podem usar este comando!');
                        return;
                    }

                    if (global.sistemaRelatorios) {
                        const configs = global.sistemaRelatorios.numerosRelatorio;
                        if (Object.keys(configs).length === 0) {
                            await message.reply(
                                `📋 *CONFIGURAÇÕES DE RELATÓRIOS*\n\n` +
                                `❌ Nenhum grupo configurado\n\n` +
                                `💡 Configure com: *.config-relatorio*`
                            );
                        } else {
                            let texto = `📋 *CONFIGURAÇÕES DE RELATÓRIOS*\n\n`;

                            for (const [grupoId, numero] of Object.entries(configs)) {
                                const grupoNome = grupoId.split('@')[0];
                                texto += `📱 ${grupoNome}\n`;
                                texto += `   📞 ${numero}\n\n`;
                            }

                            texto += `⏰ Horário: 22:00 diariamente\n`;
                            texto += `🧪 Teste: *.test-relatorio*`;

                            await message.reply(texto);
                        }
                    } else {
                        await message.reply('❌ Sistema de relatórios não está disponível');
                    }
                    return;
                }

                // .remove-relatorio GRUPO_ID - Remover configuração de relatórios (ADMIN APENAS)
                if (comando.startsWith('.remove-relatorio ')) {
                    if (!isAdmin) {
                        await message.reply('❌ Apenas administradores podem usar este comando!');
                        return;
                    }

                    const grupoId = comando.split(' ')[1];
                    if (!grupoId) {
                        await message.reply(
                            `❌ *FORMATO INCORRETO*\n\n` +
                            `✅ Use: *.remove-relatorio GRUPO_ID*\n` +
                            `💡 Liste os grupos com: *.list-relatorios*`
                        );
                        return;
                    }

                    if (global.sistemaRelatorios) {
                        global.sistemaRelatorios.removerNumeroRelatorio(grupoId);
                        await message.reply(
                            `✅ *CONFIGURAÇÃO REMOVIDA*\n\n` +
                            `📱 Grupo: ${grupoId.split('@')[0]}\n` +
                            `❌ Relatórios desativados para este grupo`
                        );
                    } else {
                        await message.reply('❌ Sistema de relatórios não está disponível');
                    }
                    return;
                }

                // .test-relatorio [GRUPO_ID] - Testar relatório (ADMIN APENAS)
                if (comando.startsWith('.test-relatorio')) {
                    if (!isAdmin) {
                        await message.reply('❌ Apenas administradores podem usar este comando!');
                        return;
                    }

                    if (!global.sistemaRelatorios) {
                        await message.reply('❌ Sistema de relatórios não está disponível');
                        return;
                    }

                    const parametros = comando.split(' ');
                    const grupoId = parametros[1] || message.from; // Usar grupo atual se não especificado

                    await message.reply(
                        `🧪 *TESTE DE RELATÓRIOS*\n\n` +
                        `📊 Gerando relatório de teste...\n` +
                        `⏳ Aguarde alguns segundos...`
                    );

                    try {
                        await global.sistemaRelatorios.testarRelatorio(grupoId);
                        await message.reply('✅ Teste concluído! Verifique se o relatório foi enviado.');
                    } catch (error) {
                        await message.reply(`❌ Erro no teste: ${error.message}`);
                    }
                    return;
                }
            }

            // === COMANDOS GOOGLE SHEETS ===
            if (comando === '.test_sheets') {
                console.log(`🧪 Testando Google Sheets...`);
                
                const resultado = await enviarParaGoogleSheets('TEST123', '99', '842223344', 'test_group', 'Teste Admin', 'TestUser');
                
                if (resultado.sucesso) {
                    await message.reply(`✅ *Google Sheets funcionando!*\n\n📊 URL: ${GOOGLE_SHEETS_CONFIG.scriptUrl}\n📝 Row: ${resultado.row}\n🎉 Dados enviados com sucesso!`);
                } else {
                    await message.reply(`❌ *Google Sheets com problema!*\n\n📊 URL: ${GOOGLE_SHEETS_CONFIG.scriptUrl}\n⚠️ Erro: ${resultado.erro}\n\n🔧 *Verifique:*\n• Script publicado corretamente\n• Permissões do Google Sheets\n• Internet funcionando`);
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
                    await message.reply(`❌ *Sintaxe incorreta!*\n\n✅ *Sintaxe correta:*\n\`.addcomando NomeComando(Sua resposta aqui)\`\n\n📝 *Exemplo:*\n\`.addcomando horario(Funcionamos de 8h às 18h)\`\n\n⚠️ *Importante:*\n• Nome sem espaços\n• Resposta entre parênteses\n• Pode usar quebras de linha`);
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
                    await message.reply('📋 *Nenhum comando customizado criado ainda*\n\n💡 **Para criar:** `.addcomando nome(resposta)`');
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

            if (comando === '.test_grupo') {
                const grupoAtual = message.from;
                const configGrupo = getConfiguracaoGrupo(grupoAtual);
                
                if (!configGrupo) {
                    await message.reply('❌ Este grupo não está configurado!');
                    return;
                }
                
                console.log(`🧪 Testando Google Sheets para grupo: ${configGrupo.nome}`);
                
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
                resposta += `📊 Via Google Sheets: ${sheets}\n`;
                resposta += `📱 Via WhatsApp: ${whatsapp}\n`;
                resposta += `📱 Fila atual: ${filaMensagens.length}\n\n`;
                
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
                
                const numero = comando.replace('.comprador ', '').trim();
                
                if (!/^\d{9}$/.test(numero)) {
                    await message.reply('❌ Use: *.comprador 849123456*');
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

            // Se não encontrou padrão direto, usar IA apenas em casos específicos
            if (texto.includes('codigo') || texto.includes('código') ||
                texto.includes('referencia') || texto.includes('referência') ||
                texto.includes('meu') || texto.includes('ver')) {

                try {
                    // Usar IA apenas quando necessário (economia de tokens)
                    const prompt = `Responda apenas SIM ou NÃO. O usuário quer ver/gerar seu código de referência?
Texto: "${texto}"

Contexto: comando normal é ".meucodigo" mas aceitar variações como "meu codigo", ".meu codigo", "ver meu código", etc.`;

                    const resposta = await ia.obterResposta(prompt, { maxTokens: 10 });
                    const resultado = resposta.toLowerCase().includes('sim');

                    if (resultado) {
                        console.log(`🧠 IA DETECTOU: "${texto}" → comando meucodigo`);
                    }

                    return resultado;
                } catch (error) {
                    console.error('❌ Erro na detecção IA:', error);
                    return false;
                }
            }

            return false;
        }

        // === DETECÇÃO INTELIGENTE DE .MEUCODIGO (QUALQUER FORMATO) ===
        if (message.type === 'chat' && await detectarIntencaoMeuCodigo(message.body)) {
            const remetente = message.author || message.from;
            let codigo = null;

            // Verificar se já tem código
            for (const [cod, dados] of Object.entries(codigosReferencia)) {
                if (dados.dono === remetente) {
                    codigo = cod;
                    break;
                }
            }

            // Se não tem, criar novo
            if (!codigo) {
                codigo = gerarCodigoReferencia(remetente);
                codigosReferencia[codigo] = {
                    dono: remetente,
                    nome: message._data.notifyName || 'N/A',
                    criado: new Date().toISOString(),
                    ativo: true
                };
                // Sistema de cache otimizado - sem salvamento em arquivos
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
                referenciasClientes[remetente] = {
                    convidadoPor: codigosReferencia[codigo].dono,
                    codigo: codigo,
                    dataRegistro: new Date().toISOString(),
                    comprasRealizadas: 0
                };
                
                // Sistema de cache otimizado - sem salvamento em arquivos
                
                const convidadorId = codigosReferencia[codigo].dono;
                const nomeConvidador = codigosReferencia[codigo].nome;
                
                await client.sendMessage(message.from, 
                    `✅ *CÓDIGO APLICADO COM SUCESSO!*\n\n` +
                    `🎉 @${convidadorId.replace('@c.us', '')} te convidou - registrado!\n\n` +
                    `💎 *Benefícios:*\n` +
                    `• Nas tuas próximas 5 compras, @${convidadorId.replace('@c.us', '')} ganha 200MB cada\n` +
                    `• Tu recebes teus megas normalmente\n` +
                    `• Ajudas um amigo a ganhar bônus!\n\n` +
                    `🚀 *Próximo passo:* Faz tua primeira compra!`, {
                    mentions: [convidadorId]
                });
                return;
            }

            // .bonus - Ver saldo de bônus
            if (comando === '.bonus' || comando === '.saldo') {
                const saldo = bonusSaldos[remetente];
                
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
                
                // Verificar saldo
                const saldo = bonusSaldos[remetente];
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
                
                // Gerar referência do pedido
                const agora = new Date();
                const referenciaSaque = `SAQ${agora.getFullYear().toString().slice(-2)}${String(agora.getMonth() + 1).padStart(2, '0')}${String(agora.getDate()).padStart(2, '0')}${String(Object.keys(pedidosSaque).length + 1).padStart(3, '0')}`;
                
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
                
                // Salvar pedido
                pedidosSaque[referenciaSaque] = pedido;
                
                // Debitar do saldo
                bonusSaldos[remetente].saldo -= quantidadeMB;
                bonusSaldos[remetente].historicoSaques = bonusSaldos[remetente].historicoSaques || [];
                bonusSaldos[remetente].historicoSaques.push({
                    referencia: referenciaSaque,
                    quantidade: quantidadeMB,
                    data: agora.toISOString()
                });

                // Salvar dados após criar saque
                agendarSalvamento();

                // Enviar para Tasker
                try {
                    await enviarParaTasker(referenciaSaque, quantidadeMB, numeroDestino, message.from, `SAQUE_BONUS_${message._data.notifyName || 'Cliente'}`);
                } catch (error) {
                    console.error('❌ Erro ao enviar saque para Tasker:', error);
                }
                
                const quantidadeFormatada = quantidadeMB >= 1024 ? `${(quantidadeMB/1024).toFixed(2)}GB` : `${quantidadeMB}MB`;
                const novoSaldo = bonusSaldos[remetente].saldo;
                
                await message.reply(
                    `✅ *SOLICITAÇÃO DE SAQUE CRIADA*\n\n` +
                    `👤 Cliente: ${message._data.notifyName || 'N/A'}\n` +
                    `📱 Número: ${numeroDestino}\n` +
                    `💎 Quantidade: ${quantidadeFormatada}\n` +
                    `🔖 Referência: *${referenciaSaque}*\n` +
                    `⏰ Processamento: até 24h\n\n` +
                    `💰 *Novo saldo:* ${novoSaldo}MB\n\n` +
                    `✅ Pedido enviado para processamento!\n` +
                    `✅ Obrigado por usar nosso sistema de referências!`
                );
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
                message.body.startsWith('.ia') ||
                message.body.startsWith('.stats') ||
                message.body.startsWith('.sheets') ||
                message.body.startsWith('.test_') ||
                message.body.startsWith('.grupos') ||
                message.body.startsWith('.clear_') ||
                message.body.startsWith('.ranking') ||
                message.body.startsWith('.inativos') ||
                message.body.startsWith('.semcompra') ||
                message.body.startsWith('.resetranking')
            );

            // Verificar se é admin executando comando
            const autorModeracaoMsg = message.author || message.from;
            const isAdminExecutando = await isAdminGrupo(message.from, autorModeracaoMsg) || isAdministrador(autorModeracaoMsg);

            // Pular moderação para comandos administrativos executados por admins
            if (!isComandoAdmin || !isAdminExecutando) {
                const analise = contemConteudoSuspeito(message.body);
                
                if (analise.suspeito) {
                    console.log(`🚨 Conteúdo suspeito detectado`);
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
                
                // Processar confirmação
                const resultadoConfirmacao = await sistemaCompras.processarConfirmacao(referenciaConfirmada, numeroConfirmado);
                
                if (resultadoConfirmacao) {
                    console.log(`✅ COMPRAS: Confirmação processada - ${resultadoConfirmacao.numero} | ${resultadoConfirmacao.megas}MB`);
                    
                    // Enviar mensagem de parabenização com menção clicável (igual às boas-vindas)
                    if (resultadoConfirmacao.mensagem && resultadoConfirmacao.contactId) {
                        try {
                            // Normalizar ID para formato @c.us igual às boas-vindas
                            const participantId = resultadoConfirmacao.contactId; // IGUAL ÀS BOAS-VINDAS
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
                } else {
                    console.log(`⚠️ COMPRAS: Confirmação ${referenciaConfirmada} não encontrada ou já processada`);
                }
                return;
            }
        }

        // === PROCESSAMENTO COM IA (LÓGICA SIMPLES IGUAL AO BOT ATACADO) ===
        const remetente = message.author || message.from;
        const resultadoIA = await ia.processarMensagemBot(message.body, remetente, 'texto', configGrupo);
        
        if (resultadoIA.erro) {
            console.error(`❌ Erro na IA:`, resultadoIA.mensagem);
            return;
        }

        if (resultadoIA.sucesso) {
            
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
                const bonusInfo = await processarBonusCompra(remetente, megas);

                // VERIFICAR PAGAMENTO ANTES DE ENVIAR PARA PLANILHA
                // Usar o valor real do comprovante (não o valor calculado dos megas)
                const valorComprovante = resultadoIA.valorComprovante || megas;
                const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorComprovante);

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

                const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, message.from, autorMensagem);

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

                await registrarComprador(message.from, numero, nomeContato, megas);
                
                if (message.from === ENCAMINHAMENTO_CONFIG.grupoOrigem) {
                    const timestampMensagem = new Date().toLocaleString('pt-BR');
                    adicionarNaFila(dadosCompletos, autorMensagem, configGrupo.nome, timestampMensagem);
                }
                
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
                const bonusInfo = await processarBonusCompra(remetente, megas);

                // VERIFICAR PAGAMENTO ANTES DE ENVIAR PARA PLANILHA
                // Usar o valor real do comprovante (não o valor calculado dos megas)
                const valorComprovante = resultadoIA.valorComprovante || megas;
                const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorComprovante);

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

                const resultadoEnvio = await enviarParaTasker(referencia, megas, numero, message.from, autorMensagem);

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

                await registrarComprador(message.from, numero, nomeContato, megas);
                
                if (message.from === ENCAMINHAMENTO_CONFIG.grupoOrigem) {
                    const timestampMensagem = new Date().toLocaleString('pt-BR');
                    adicionarNaFila(dadosCompletos, autorMensagem, configGrupo.nome, timestampMensagem);
                }
                
                await message.reply(
                    `✅ *Pedido Recebido!*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 Megas: ${megas}\n` +
                    `📱 Número: ${numero}\n\n` +
                    `_⏳Processando... Aguarde enquanto o Sistema executa a transferência_`
                );
                return;
            }
        }

        // === TRATAMENTO DE ERROS ===
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
        // PRIMEIRO: Tentar aprender mapeamentos LID automaticamente
        await aprenderMapeamento(message);

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
    console.log('🔧 Comandos carregados, inicializando cliente WhatsApp...');
    
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
    console.log('📊 Google Sheets: CONFIGURADO');
    console.log(`🔗 URL: ${GOOGLE_SHEETS_CONFIG.scriptUrl}`);
    console.log('🤖 Bot Retalho - Funcionamento otimizado');
    console.log(ia.getStatus());
    process.exit(0);
});










