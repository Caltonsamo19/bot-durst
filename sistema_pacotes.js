const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class SistemaPacotes {
    constructor() {
        console.log('📦 Inicializando Sistema de Pacotes Automáticos...');
        
        // Configurações das planilhas
        this.PLANILHAS = {
            // PEDIDOS: Usar a MESMA planilha do bot retalho
            PEDIDOS: process.env.GOOGLE_SHEETS_SCRIPT_URL_RETALHO || 'https://script.google.com/macros/s/AKfycbyMilUC5bYKGXV95LR4MmyaRHzMf6WCmXeuztpN0tDpQ9_2qkgCxMipSVqYK_Q6twZG/exec',
            // PAGAMENTOS: Planilha separada (universal)
            PAGAMENTOS: process.env.GOOGLE_SHEETS_PAGAMENTOS
        };
        
        // Tipos de pacotes disponíveis
        this.TIPOS_PACOTES = {
            '3': { dias: 3, nome: '3 Dias' },
            '5': { dias: 5, nome: '5 Dias' },
            '15': { dias: 15, nome: '15 Dias' },
            '30': { dias: 30, nome: '30 Dias' }
        };
        
        // Arquivo para persistir dados dos clientes ativos
        this.ARQUIVO_CLIENTES = path.join(__dirname, 'dados_pacotes_clientes.json');
        this.ARQUIVO_HISTORICO = path.join(__dirname, 'historico_renovacoes.json');

        // Arquivos de backup
        this.PASTA_BACKUP = path.join(__dirname, 'backup_pacotes');
        this.ARQUIVO_BACKUP_CLIENTES = path.join(this.PASTA_BACKUP, 'dados_pacotes_clientes_backup.json');
        this.ARQUIVO_BACKUP_HISTORICO = path.join(this.PASTA_BACKUP, 'historico_renovacoes_backup.json');
        this.ARQUIVO_BACKUP_ROTATIVO = path.join(this.PASTA_BACKUP, 'dados_pacotes_backup_');

        // Controle de clientes ativos
        this.clientesAtivos = {};
        this.historicoRenovacoes = [];
        
        // Timer de verificação
        this.timerVerificacao = null;
        this.intervalVerificacao = parseInt(process.env.VERIFICACAO_INTERVAL) || 3600000; // 1 hora padrão
        
        console.log(`📦 URLs Configuradas:`);
        console.log(`   📋 Pedidos (Retalho): ${this.PLANILHAS.PEDIDOS}`);
        console.log(`   💰 Pagamentos (Universal): ${this.PLANILHAS.PAGAMENTOS}`);
        console.log(`   ⏱️ Verificação: ${this.intervalVerificacao/60000} min`);

        // Garantir que a pasta de backup existe
        this.garantirPastaBackup();

        // Carregar dados persistidos
        this.carregarDados();
        
        // Iniciar verificação automática
        this.iniciarVerificacaoAutomatica();
    }
    
    // === CARREGAR DADOS PERSISTIDOS ===
    async carregarDados() {
        try {
            // Carregar clientes ativos com backup automático
            try {
                const dadosClientes = await fs.readFile(this.ARQUIVO_CLIENTES, 'utf8');
                const dadosParsados = JSON.parse(dadosClientes);

                // Validar se os dados carregados são válidos
                if (dadosParsados && typeof dadosParsados === 'object') {
                    this.clientesAtivos = dadosParsados;
                    console.log(`📦 ${Object.keys(this.clientesAtivos).length} clientes ativos carregados`);

                    // Criar backup automático após carregamento bem-sucedido
                    await this.criarBackupPacotes();
                } else {
                    throw new Error('Dados inválidos no arquivo de clientes');
                }
            } catch (error) {
                console.log(`⚠️ Erro ao carregar clientes: ${error.message}`);

                // Tentar restaurar do backup
                const backupRestaurado = await this.restaurarBackupPacotes();
                if (backupRestaurado) {
                    console.log('✅ Clientes restaurados do backup!');
                } else {
                    console.log(`📦 Nenhum arquivo de clientes encontrado - iniciando limpo`);
                    this.clientesAtivos = {};
                }
            }
            
            // Carregar histórico
            try {
                const dadosHistorico = await fs.readFile(this.ARQUIVO_HISTORICO, 'utf8');
                this.historicoRenovacoes = JSON.parse(dadosHistorico);
                console.log(`📦 ${this.historicoRenovacoes.length} registros de histórico carregados`);
            } catch (error) {
                console.log(`📦 Nenhum histórico encontrado - iniciando limpo`);
                this.historicoRenovacoes = [];
            }
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao carregar dados:`, error);
        }
    }
    
    // === SALVAR DADOS COM BACKUP AUTOMÁTICO ===
    async salvarDados() {
        try {
            const qtdClientes = Object.keys(this.clientesAtivos).length;
            console.log(`💾 PACOTES: Salvando dados (${qtdClientes} clientes)...`);

            // Criar backup antes de salvar (apenas se houver dados)
            if (qtdClientes > 0) {
                await this.criarBackupPacotes();
            }

            // Salvar clientes ativos
            await fs.writeFile(this.ARQUIVO_CLIENTES, JSON.stringify(this.clientesAtivos, null, 2));

            // Salvar histórico (manter apenas últimos 1000 registros)
            const historicoLimitado = this.historicoRenovacoes.slice(-1000);
            await fs.writeFile(this.ARQUIVO_HISTORICO, JSON.stringify(historicoLimitado, null, 2));

            console.log(`✅ PACOTES: Dados salvos - ${qtdClientes} clientes ativos`);
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao salvar dados:`, error);
        }
    }
    
    // === EXTRAIR PACOTES RENOVÁVEIS DA TABELA (PARSING DINÂMICO) ===
    extrairPacotesRenovaveis(tabelaTexto) {
        const pacotesExtraidos = {
            '3': [],
            '5': [],
            '15': []
        };

        try {
            // Regex para encontrar seções de pacotes renováveis
            const padroes = [
                { tipo: '3', regex: /3\s*Dias[^\n]*(?:Renováveis)?[^\n]*\n([\s\S]*?)(?=\n\n|📅|💎|📍|$)/i },
                { tipo: '5', regex: /5\s*Dias[^\n]*(?:Renováveis)?[^\n]*\n([\s\S]*?)(?=\n\n|📅|💎|📍|$)/i },
                { tipo: '15', regex: /15\s*Dias[^\n]*(?:Renováveis)?[^\n]*\n([\s\S]*?)(?=\n\n|📅|💎|📍|$)/i }
            ];

            for (const { tipo, regex } of padroes) {
                const match = tabelaTexto.match(regex);
                if (match && match[1]) {
                    const secao = match[1];

                    // Extrair pares MB = MT
                    // Suporta formatos: "2000MB = 44MT", "2.0GB = 44MT", "2000 MB = 44 MT"
                    const regexPacotes = /(\d+(?:\.\d+)?)\s*(?:MB|GB)\s*=\s*(\d+(?:\.\d+)?)\s*MT/gi;
                    let matchPacote;

                    while ((matchPacote = regexPacotes.exec(secao)) !== null) {
                        let mb = parseFloat(matchPacote[1]);
                        const valor = parseFloat(matchPacote[2]);

                        // Se for GB, converter para MB
                        if (matchPacote[0].toUpperCase().includes('GB')) {
                            mb = mb * 1024;
                        }

                        pacotesExtraidos[tipo].push({ mb: Math.round(mb), valor });
                    }
                }
            }

            console.log(`📋 PACOTES: Extraídos da tabela:`, {
                '3 dias': pacotesExtraidos['3'].length,
                '5 dias': pacotesExtraidos['5'].length,
                '15 dias': pacotesExtraidos['15'].length
            });

        } catch (error) {
            console.error(`❌ PACOTES: Erro ao extrair pacotes da tabela:`, error.message);
        }

        return pacotesExtraidos;
    }

    // === DETECTAR TIPO DE PACOTE AUTOMATICAMENTE ===
    detectarTipoPacote(mb, valor, tabelaTexto) {
        try {
            const pacotesDisponiveis = this.extrairPacotesRenovaveis(tabelaTexto);

            // Procurar combinação exata de MB + Valor
            for (const [tipoDias, listaPacotes] of Object.entries(pacotesDisponiveis)) {
                for (const pacote of listaPacotes) {
                    // Comparar com tolerância de 1% para valores (arredondamentos)
                    const mbMatch = Math.abs(pacote.mb - mb) <= (mb * 0.01);
                    const valorMatch = Math.abs(pacote.valor - valor) <= (valor * 0.01);

                    if (mbMatch && valorMatch) {
                        console.log(`✅ PACOTES: Detectado pacote de ${tipoDias} dias (${mb}MB + ${valor}MT)`);
                        return tipoDias;
                    }
                }
            }

            console.log(`ℹ️ PACOTES: Pacote ${mb}MB + ${valor}MT não é renovável`);
            return null;

        } catch (error) {
            console.error(`❌ PACOTES: Erro ao detectar tipo de pacote:`, error.message);
            return null;
        }
    }

    // === CRIAR PACOTE (SEM VERIFICAÇÃO DE PAGAMENTO) ===
    async processarComprovante(referencia, numero, grupoId, tipoPacote, horarioAtivacao = null) {
        try {
            console.log(`📦 Processando pacote: ${referencia}`);

            // 1. Verificar se a referência já foi usada (evitar duplicatas)
            const referenciaExiste = await this.verificarReferenciaExistente(referencia);
            if (referenciaExiste) {
                console.log(`❌ PACOTES: Referência ${referencia} já foi utilizada`);
                return { sucesso: false, erro: 'Esta referência já foi utilizada para criar um pacote' };
            }

            // 2. Verificar se é um tipo de pacote válido
            if (!this.TIPOS_PACOTES[tipoPacote]) {
                console.log(`❌ PACOTES: Tipo de pacote inválido: ${tipoPacote}`);
                return { sucesso: false, erro: 'Tipo de pacote inválido' };
            }

            // 3. Calcular datas
            const agora = new Date();
            const horaAtivacao = horarioAtivacao ? new Date(horarioAtivacao) : agora;
            const diasPacote = this.TIPOS_PACOTES[tipoPacote].dias;
            const dataExpiracao = new Date(horaAtivacao.getTime() + (diasPacote * 24 * 60 * 60 * 1000));

            // 4. NOVA LÓGICA: NÃO criar D1 imediatamente, apenas agendar
            // Calcular primeira renovação: DIA SEGUINTE, 2h ANTES da hora de ativação
            const primeiraRenovacao = new Date(horaAtivacao);
            primeiraRenovacao.setDate(primeiraRenovacao.getDate() + 1); // +1 dia
            primeiraRenovacao.setHours(primeiraRenovacao.getHours() - 2); // -2 horas

            // 5. Registrar cliente no sistema (SEM criar D1 agora)
            const clienteId = `${numero}_${referencia}`;
            this.clientesAtivos[clienteId] = {
                numero: numero,
                referenciaOriginal: referencia,
                grupoId: grupoId,
                tipoPacote: tipoPacote,
                diasTotal: diasPacote,
                diasRestantes: diasPacote, // AGORA é diasPacote (não -1)
                dataInicio: agora.toISOString(),
                dataExpiracao: dataExpiracao.toISOString(),
                horaEnvioOriginal: horaAtivacao.toISOString(),
                proximaRenovacao: primeiraRenovacao.toISOString(),
                renovacoes: 0,
                status: 'ativo',
                ultimaRenovacao: null // Ainda não teve renovação
            };

            // 6. Salvar dados
            await this.salvarDados();

            console.log(`✅ Cliente ativado com ${this.TIPOS_PACOTES[tipoPacote].nome}`);
            console.log(`📅 Primeira renovação agendada para: ${primeiraRenovacao.toLocaleString('pt-BR')}`);

            return {
                sucesso: true,
                cliente: this.clientesAtivos[clienteId],
                mensagem: `🎯 **PACOTE ${this.TIPOS_PACOTES[tipoPacote].nome} ATIVADO!**\n\n` +
                         `📱 **Número:** ${numero}\n` +
                         `📋 **Referência:** ${referencia}\n` +
                         `📅 **Duração:** ${diasPacote} dias\n` +
                         `⚡ **Pacote principal já foi ativado**\n` +
                         `🔄 **Renovações automáticas:** ${diasPacote}x (100MB cada)\n` +
                         `📅 **Primeira renovação:** ${primeiraRenovacao.toLocaleDateString('pt-BR')} às ${primeiraRenovacao.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})} (2h antes)\n` +
                         `📅 **Expira em:** ${dataExpiracao.toLocaleDateString('pt-BR')}\n\n` +
                         `💡 *O cliente pode verificar a validade com: .validade ${numero}*`
            };

        } catch (error) {
            console.error(`❌ PACOTES: Erro ao processar comprovante:`, error);
            return { sucesso: false, erro: error.message };
        }
    }
    
    // === VERIFICAR SE REFERÊNCIA JÁ FOI USADA ===
    async verificarReferenciaExistente(referencia) {
        try {
            // Verificar nos clientes ativos
            for (const cliente of Object.values(this.clientesAtivos)) {
                if (cliente.referenciaOriginal === referencia) {
                    console.log(`⚠️ PACOTES: Referência ${referencia} encontrada nos clientes ativos`);
                    return true;
                }
            }
            
            // Verificar no histórico recente (últimos 100 registros)
            const historicoRecente = this.historicoRenovacoes.slice(-100);
            for (const renovacao of historicoRecente) {
                if (renovacao.referenciaOriginal === referencia) {
                    console.log(`⚠️ PACOTES: Referência ${referencia} encontrada no histórico`);
                    return true;
                }
            }
            
            console.log(`✅ PACOTES: Referência ${referencia} disponível para uso`);
            return false;
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao verificar referência:`, error.message);
            return false; // Em caso de erro, permitir uso (segurança)
        }
    }

    // === VERIFICAR PAGAMENTO NA PLANILHA ===
    async verificarPagamento(referencia, valor) {
        try {
            console.log(`🔍 PACOTES: Verificando pagamento ${referencia} - ${valor}MT`);
            
            const response = await axios.post(this.PLANILHAS.PAGAMENTOS, {
                action: "buscar_por_referencia",
                referencia: referencia,
                valor: parseFloat(valor)
            }, {
                timeout: 60000, // 60s (aumentado de 15s para evitar timeout)
                headers: { 'Content-Type': 'application/json' }
            });
            
            const encontrado = response.data && response.data.encontrado;
            console.log(`${encontrado ? '✅' : '❌'} PACOTES: Pagamento ${encontrado ? 'encontrado' : 'não encontrado'}`);
            
            return encontrado;
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao verificar pagamento:`, error.message);
            return false;
        }
    }
    
    // === CALCULAR VALOR DE 100MB BASEADO NO GRUPO ===
    calcularValor100MB(grupoId) {
        // Baseado na proporção típica do sistema (exemplo: 1GB = 125MT, então 100MB = 12.5MT)
        // Valores típicos observados: 10GB=1250MT, 1GB=125MT, 100MB=12.5MT
        
        // Pode ser personalizado por grupo no futuro
        // Por enquanto, usa valor padrão baseado na proporção comum
        return 12.5; // 100MB = 12.5MT
        
        // TODO: Implementar configuração por grupo se necessário
        // const configGrupo = this.CONFIGURACOES_GRUPOS[grupoId];
        // if (configGrupo && configGrupo.precoPor100MB) {
        //     return configGrupo.precoPor100MB;
        // }
    }
    
    // === CRIAR PEDIDO PARA PACOTE ===
    async criarPedidoPacote(novaReferencia, megas, numero, grupoId, horarioEnvio) {
        try {
            console.log(`📋 Criando pedido: ${novaReferencia}`);
            
            const timestamp = new Date().toLocaleString('pt-BR');
            const dadosCompletos = `${novaReferencia}|${megas}|${numero}`; // Formato correto: REF|MEGAS|NUMERO (sem timestamp)
            
            // FORMATO PARA PLANILHA DE PEDIDOS (IGUAL AOS PEDIDOS NORMAIS)
            const dados = {
                grupo_id: grupoId,
                timestamp: timestamp,
                transacao: dadosCompletos, // Key para pedidos (REF|MEGAS|NUMERO) - CORRIGIDO: transacao não dados
                sender: "WhatsApp-Bot-Pacotes",
                message: `Pacote automatico: ${dadosCompletos}`
            };
            
            console.log(`📋 Enviando pedido para planilha`);
            
            const response = await axios.post(this.PLANILHAS.PEDIDOS, dados, {
                timeout: 60000, // 60s (aumentado de 20s para evitar timeout)
                headers: { 'Content-Type': 'application/json' }
            });
            
            // Verificar resposta do script (compatível com string e JSON)
            console.log(`🔍 PACOTES: Resposta do script (tipo: ${typeof response.data}):`, response.data);

            let isSuccess = false;

            if (typeof response.data === 'string') {
                // Resposta em string (formato antigo)
                isSuccess = response.data.includes('Sucesso') || response.data.includes('success');
            } else if (response.data && typeof response.data === 'object') {
                // Resposta em JSON (formato atual)
                isSuccess = response.data.success === true;
            }

            if (!isSuccess) {
                // Se for erro de duplicata com status PROCESSADO, apenas loga e continua
                if (response.data && response.data.duplicado && response.data.status_existente === 'PROCESSADO') {
                    console.log(`⚠️ PACOTES: Pedido ${novaReferencia} já existe com status PROCESSADO - pulando criação`);
                    return; // Retorna sem erro para não quebrar o fluxo
                }
                throw new Error(`Erro ao salvar pedido pacote: ${JSON.stringify(response.data)}`);
            }
            
            console.log(`✅ Pedido criado: ${novaReferencia}`);
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao criar pedido pacote:`, error.message);
            throw error;
        }
    }

    // === CRIAR PAGAMENTO PARA PACOTE (FORMATO CORRETO) ===
    async criarPagamentoPacote(novaReferencia, valorMT, numero, grupoId, horarioEnvio) {
        try {
            console.log(`💰 Criando pagamento: ${novaReferencia}`);
            
            const timestamp = new Date().toLocaleString('pt-BR');
            const dadosCompletos = `${novaReferencia}|${valorMT}|${numero}`; // Formato correto: REF|VALOR|NUMERO
            
            // USAR EXATAMENTE O MESMO FORMATO DA PLANILHA DE PAGAMENTOS
            const dados = {
                grupo_id: grupoId,
                timestamp: timestamp,
                transacao: dadosCompletos, // Key correta para pagamentos (REF|VALOR|NUMERO)
                sender: "WhatsApp-Bot-Pacotes",
                message: `Pacote automatico: Renovacao ${novaReferencia} - ${valorMT}MT para ${numero}`
            };
            
            console.log(`💰 Enviando pagamento para planilha`);
            
            const response = await axios.post(this.PLANILHAS.PAGAMENTOS, dados, {
                timeout: 60000, // 60s (aumentado de 20s para evitar timeout)
                headers: { 'Content-Type': 'application/json' }
            });
            
            // Verificar se foi sucesso - pode ser objeto {success: true}, string "Sucesso!" ou duplicado (que deve ser tratado como sucesso)
            const isDuplicado = (response.data && response.data.duplicado === true) ||
                               (typeof response.data === 'string' && response.data.includes('Duplicado'));
            
            const isSuccess = (response.data && response.data.success) || 
                             isDuplicado ||
                             (typeof response.data === 'string' && (
                                 response.data.includes('Sucesso') || 
                                 response.data.includes('IGNORADO')
                             ));
            
            // Se for duplicado, tratar como sucesso silencioso (não erro)
            if (isDuplicado) {
                console.log(`⚠️ Pagamento duplicado ignorado: ${novaReferencia}`);
                return; // Sair sem erro
            }
            
            if (!response.data || !isSuccess) {
                throw new Error(`Erro ao salvar pagamento pacote: ${JSON.stringify(response.data)}`);
            }
            
            console.log(`✅ Pagamento criado: ${novaReferencia}`);
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao criar pagamento pacote:`, error.message);
            throw error;
        }
    }
    
    // === CALCULAR PRÓXIMA RENOVAÇÃO (2H ANTES NO DIA SEGUINTE) ===
    calcularProximaRenovacao(ultimoEnvio) {
        const proximoEnvio = new Date(ultimoEnvio);
        proximoEnvio.setDate(proximoEnvio.getDate() + 1); // +1 dia
        proximoEnvio.setHours(proximoEnvio.getHours() - 2); // -2 horas
        return proximoEnvio.toISOString();
    }
    
    // === VERIFICAÇÃO AUTOMÁTICA ===
    iniciarVerificacaoAutomatica() {
        if (this.timerVerificacao) {
            clearInterval(this.timerVerificacao);
        }
        
        console.log(`⏰ PACOTES: Verificação automática iniciada (${this.intervalVerificacao/60000} min)`);
        
        this.timerVerificacao = setInterval(async () => {
            await this.verificarRenovacoes();
        }, this.intervalVerificacao);
        
        // Fazer primeira verificação em 30 segundos (sem bloquear inicialização)
        setTimeout(async () => {
            await this.verificarRenovacoes();
            console.log('📦 Sistema de Pacotes Automáticos completamente inicializado!');
        }, 30000);
    }
    
    // === VERIFICAR RENOVAÇÕES ===
    async verificarRenovacoes() {
        try {
            const agora = new Date();
            console.log(`🔄 PACOTES: Verificando renovações... (${agora.toLocaleString('pt-BR')})`);
            
            // Se não há clientes ativos, não há nada para verificar
            if (Object.keys(this.clientesAtivos).length === 0) {
                console.log(`📦 PACOTES: Nenhum cliente ativo - verificação concluída`);
                return;
            }
            
            let renovacoesProcessadas = 0;
            let expiracoes = 0;
            
            for (const [clienteId, cliente] of Object.entries(this.clientesAtivos)) {
                try {
                    const proximaRenovacao = new Date(cliente.proximaRenovacao);
                    const dataExpiracao = new Date(cliente.dataExpiracao);
                    
                    // Verificar se expirou
                    if (agora >= dataExpiracao) {
                        console.log(`⌛ Cliente expirado - removendo`);
                        delete this.clientesAtivos[clienteId];
                        expiracoes++;
                        continue;
                    }
                    
                    // Verificar se precisa renovar (quando chegar na hora programada)
                    if (agora >= proximaRenovacao && cliente.diasRestantes > 0) {
                        await this.processarRenovacao(clienteId, cliente);
                        renovacoesProcessadas++;
                    }
                    
                } catch (error) {
                    console.error(`❌ PACOTES: Erro ao processar cliente ${clienteId}:`, error);
                }
            }
            
            if (renovacoesProcessadas > 0 || expiracoes > 0) {
                await this.salvarDados();
            }
            
            console.log(`✅ Verificação: ${renovacoesProcessadas} renovações, ${expiracoes} expirações`);
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro na verificação automática:`, error);
        }
    }
    
    // === PROCESSAR RENOVAÇÃO ===
    async processarRenovacao(clienteId, cliente) {
        try {
            console.log(`🔄 Processando renovação (${cliente.diasRestantes} dias)`);
            
            // Criar nova referência
            const diaAtual = cliente.diasTotal - cliente.diasRestantes + 1;
            const novaReferencia = `${cliente.referenciaOriginal}D${diaAtual + 1}`;
            
            // Criar PEDIDO e PAGAMENTO de renovação (ambos para Tasker)
            const agora = new Date();
            const valor100MB = this.calcularValor100MB(cliente.grupoId);
            
            // Criar PEDIDO na planilha de pedidos
            await this.criarPedidoPacote(novaReferencia, 100, cliente.numero, cliente.grupoId, agora);
            
            // Criar PAGAMENTO na planilha de pagamentos (mesma referência)
            await this.criarPagamentoPacote(novaReferencia, valor100MB, cliente.numero, cliente.grupoId, agora);
            
            // Atualizar dados do cliente
            cliente.diasRestantes -= 1;
            cliente.renovacoes += 1;
            cliente.ultimaRenovacao = agora.toISOString();
            
            // Calcular próxima renovação: 2h antes do horário atual AMANHÃ
            if (cliente.diasRestantes > 0) {
                cliente.proximaRenovacao = this.calcularProximaRenovacao(agora);
            }
            
            // Registrar no histórico
            this.historicoRenovacoes.push({
                clienteId: clienteId,
                numero: cliente.numero,
                referenciaOriginal: cliente.referenciaOriginal,
                novaReferencia: novaReferencia,
                dia: diaAtual + 1,
                diasRestantes: cliente.diasRestantes,
                proximaRenovacao: cliente.proximaRenovacao,
                timestamp: agora.toISOString()
            });
            
            console.log(`✅ Renovação criada: ${novaReferencia} (${cliente.diasRestantes} dias)`);
            if (cliente.diasRestantes > 0) {
                const proximaData = new Date(cliente.proximaRenovacao);
                console.log(`   📅 Próxima: ${proximaData.toLocaleDateString('pt-BR')}`);
            }
            
        } catch (error) {
            console.error(`❌ PACOTES: Erro ao processar renovação:`, error);
            throw error;
        }
    }
    
    // === COMANDOS ADMINISTRATIVOS ===
    
    // Listar clientes ativos
    listarClientesAtivos(grupoIdFiltro = null) {
        const todosClientes = Object.values(this.clientesAtivos);

        // Filtrar por grupo se especificado
        const clientes = grupoIdFiltro
            ? todosClientes.filter(cliente => cliente.grupoId === grupoIdFiltro)
            : todosClientes;

        if (clientes.length === 0) {
            const textoGrupo = grupoIdFiltro ? ' neste grupo' : '';
            return `📦 *PACOTES ATIVOS*\n\n❌ Nenhum cliente com pacote ativo${textoGrupo}.`;
        }

        const textoGrupo = grupoIdFiltro ? ` - ESTE GRUPO` : ` - TODOS OS GRUPOS`;
        let resposta = `📦 *PACOTES ATIVOS* (${clientes.length})${textoGrupo}\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        clientes.forEach((cliente, index) => {
            const dataExpiracao = new Date(cliente.dataExpiracao);
            const diasAteExpiracao = Math.ceil((dataExpiracao - new Date()) / (24 * 60 * 60 * 1000));

            resposta += `${index + 1}. **${cliente.numero}**\n`;
            resposta += `   📋 Ref: ${cliente.referenciaOriginal}\n`;
            resposta += `   📦 Tipo: ${this.TIPOS_PACOTES[cliente.tipoPacote].nome}\n`;
            resposta += `   📅 Restam: ${cliente.diasRestantes} dias\n`;
            resposta += `   🔄 Renovações: ${cliente.renovacoes}\n`;
            resposta += `   ⏰ Expira: ${diasAteExpiracao > 0 ? `${diasAteExpiracao}d` : 'HOJE'}\n\n`;
        });
        
        return resposta;
    }
    
    // Estatísticas do sistema
    obterEstatisticas() {
        const clientes = Object.values(this.clientesAtivos);
        const stats = {
            total: clientes.length,
            porTipo: {},
            renovacoes24h: 0,
            proximasRenovacoes: []
        };
        
        // Contar por tipo
        Object.keys(this.TIPOS_PACOTES).forEach(tipo => {
            stats.porTipo[tipo] = clientes.filter(c => c.tipoPacote === tipo).length;
        });
        
        // Contar renovações nas últimas 24h
        const umDiaAtras = new Date(Date.now() - (24 * 60 * 60 * 1000));
        stats.renovacoes24h = this.historicoRenovacoes.filter(r => 
            new Date(r.timestamp) >= umDiaAtras
        ).length;
        
        // Próximas renovações (próximas 6h)
        const proximas6h = new Date(Date.now() + (6 * 60 * 60 * 1000));
        stats.proximasRenovacoes = clientes.filter(c => {
            const proxima = new Date(c.proximaRenovacao);
            return proxima <= proximas6h;
        }).map(c => ({
            numero: c.numero,
            proximaRenovacao: c.proximaRenovacao,
            diasRestantes: c.diasRestantes
        }));
        
        let resposta = `📊 *ESTATÍSTICAS PACOTES*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        resposta += `📦 **Total de clientes ativos:** ${stats.total}\n\n`;
        
        resposta += `📋 **Por tipo de pacote:**\n`;
        Object.entries(this.TIPOS_PACOTES).forEach(([tipo, config]) => {
            resposta += `   • ${config.nome}: ${stats.porTipo[tipo] || 0} clientes\n`;
        });
        
        resposta += `\n🔄 **Renovações últimas 24h:** ${stats.renovacoes24h}\n`;
        resposta += `⏰ **Próximas renovações (6h):** ${stats.proximasRenovacoes.length}\n`;
        
        if (stats.proximasRenovacoes.length > 0) {
            resposta += `\n📅 **Próximas renovações:**\n`;
            stats.proximasRenovacoes.forEach(r => {
                const proxima = new Date(r.proximaRenovacao);
                resposta += `   • ${r.numero}: ${proxima.toLocaleString('pt-BR')} (${r.diasRestantes}d restantes)\n`;
            });
        }
        
        return resposta;
    }
    
    // Verificar validade do pacote para um número
    verificarValidadePacote(numero) {
        // Buscar pacote ativo pelo número
        const cliente = Object.values(this.clientesAtivos).find(c => c.numero === numero);
        
        if (!cliente) {
            return `❌ **PACOTE NÃO ENCONTRADO**\n\n📱 Número: ${numero}\n\n💡 Este número não possui nenhum pacote ativo no momento.`;
        }
        
        const agora = new Date();
        const dataExpiracao = new Date(cliente.dataExpiracao);
        const proximaRenovacao = new Date(cliente.proximaRenovacao);
        
        // Calcular tempo restante
        const diasAteExpiracao = Math.ceil((dataExpiracao - agora) / (24 * 60 * 60 * 1000));
        const horasAteRenovacao = Math.ceil((proximaRenovacao - agora) / (60 * 60 * 1000));
        
        // Status da próxima renovação
        let statusRenovacao = '';
        if (cliente.diasRestantes > 0) {
            if (horasAteRenovacao <= 0) {
                statusRenovacao = '⏰ **PROCESSANDO AGORA** (pode demorar até 1h)';
            } else if (horasAteRenovacao <= 2) {
                statusRenovacao = `⏰ **EM ${horasAteRenovacao}h** (${proximaRenovacao.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})})`;
            } else {
                statusRenovacao = `📅 **${proximaRenovacao.toLocaleDateString('pt-BR')} às ${proximaRenovacao.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}**`;
            }
        } else {
            statusRenovacao = '🏁 **PACOTE FINALIZADO** (sem mais renovações)';
        }
        
        return `📱 **VALIDADE DO PACOTE**\n━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
               `📱 **Número:** ${numero}\n` +
               `📋 **Referência:** ${cliente.referenciaOriginal}\n` +
               `📦 **Tipo:** ${this.TIPOS_PACOTES[cliente.tipoPacote].nome}\n\n` +
               `📅 **Status do Pacote:**\n` +
               `   • **Dias restantes:** ${cliente.diasRestantes} dias\n` +
               `   • **Renovações feitas:** ${cliente.renovacoes}/${cliente.diasTotal}\n` +
               `   • **Expira em:** ${diasAteExpiracao > 0 ? `${diasAteExpiracao} dia(s)` : 'HOJE'} (${dataExpiracao.toLocaleDateString('pt-BR')})\n\n` +
               `🔄 **Próxima Renovação (100MB):**\n   ${statusRenovacao}\n\n` +
               `💡 *Cada renovação adiciona 100MB válidos por 24h. O sistema renova automaticamente 2h antes do horário anterior.*`;
    }

    // Cancelar pacote
    cancelarPacote(numero, referencia) {
        const clienteId = `${numero}_${referencia}`;
        
        if (!this.clientesAtivos[clienteId]) {
            return `❌ Cliente ${numero} com referência ${referencia} não encontrado nos pacotes ativos.`;
        }
        
        const cliente = this.clientesAtivos[clienteId];
        delete this.clientesAtivos[clienteId];
        
        // Salvar dados
        this.salvarDados();
        
        return `✅ **PACOTE CANCELADO**\n\n📱 Número: ${numero}\n📋 Referência: ${referencia}\n📦 Tipo: ${this.TIPOS_PACOTES[cliente.tipoPacote].nome}\n📅 Dias restantes: ${cliente.diasRestantes}\n\n💡 O cliente não receberá mais renovações automáticas.`;
    }
    
    // === PARAR SISTEMA ===
    parar() {
        if (this.timerVerificacao) {
            clearInterval(this.timerVerificacao);
            this.timerVerificacao = null;
        }
        
        console.log(`🛑 PACOTES: Sistema de pacotes parado`);
    }
    
    // === STATUS DO SISTEMA ===
    getStatus() {
        return {
            ativo: !!this.timerVerificacao,
            clientesAtivos: Object.keys(this.clientesAtivos).length,
            intervalVerificacao: this.intervalVerificacao,
            ultimaVerificacao: new Date().toISOString(),
            tiposPacotes: Object.keys(this.TIPOS_PACOTES),
            historicoSize: this.historicoRenovacoes.length
        };
    }

    // === SISTEMA DE BACKUP AUTOMÁTICO ===

    // Garantir que pasta de backup existe
    async garantirPastaBackup() {
        try {
            await fs.mkdir(this.PASTA_BACKUP, { recursive: true });
            console.log('📁 Pasta de backup de pacotes verificada');
        } catch (error) {
            console.log('⚠️ Erro ao criar pasta de backup:', error.message);
        }
    }

    // Criar backup dos dados de pacotes
    async criarBackupPacotes() {
        try {
            if (Object.keys(this.clientesAtivos).length === 0) {
                return; // Não criar backup de dados vazios
            }

            await this.garantirPastaBackup();

            const agora = new Date();
            const timestamp = agora.toISOString().replace(/[:.]/g, '-');
            const dadosBackup = {
                timestamp: agora.toISOString(),
                versao: '1.0',
                totalClientes: Object.keys(this.clientesAtivos).length,
                totalHistorico: this.historicoRenovacoes.length,
                clientes: this.clientesAtivos,
                historico: this.historicoRenovacoes.slice(-1000) // Últimos 1000 registros
            };

            // Backup principal (sempre sobrescreve)
            await fs.writeFile(this.ARQUIVO_BACKUP_CLIENTES, JSON.stringify(dadosBackup, null, 2));

            // Backup rotativo (manter últimos 7 dias)
            const arquivoRotativo = `${this.ARQUIVO_BACKUP_ROTATIVO}${timestamp}.json`;
            await fs.writeFile(arquivoRotativo, JSON.stringify(dadosBackup, null, 2));

            // Limpar backups antigos
            await this.limparBackupsAntigosPacotes();

            console.log(`💾 Backup de pacotes criado: ${Object.keys(this.clientesAtivos).length} clientes ativos`);

        } catch (error) {
            console.error('❌ Erro ao criar backup de pacotes:', error.message);
        }
    }

    // Restaurar backup de pacotes
    async restaurarBackupPacotes() {
        try {
            console.log('🔄 Tentando restaurar backup de pacotes...');

            // Tentar restaurar backup principal primeiro
            try {
                const dadosBackup = await fs.readFile(this.ARQUIVO_BACKUP_CLIENTES, 'utf8');
                const backup = JSON.parse(dadosBackup);

                if (backup.clientes && typeof backup.clientes === 'object') {
                    this.clientesAtivos = backup.clientes;
                    if (backup.historico && Array.isArray(backup.historico)) {
                        this.historicoRenovacoes = backup.historico;
                    }
                    console.log(`✅ Backup principal de pacotes restaurado: ${Object.keys(this.clientesAtivos).length} clientes`);
                    await this.salvarDados();
                    return true;
                }
            } catch (error) {
                console.log('⚠️ Backup principal de pacotes não disponível, tentando backups rotativos...');
            }

            // Tentar restaurar do backup rotativo mais recente
            try {
                const arquivos = await fs.readdir(this.PASTA_BACKUP);
                const backupsRotativos = arquivos
                    .filter(arquivo => arquivo.startsWith('dados_pacotes_backup_') && arquivo.endsWith('.json'))
                    .sort()
                    .reverse(); // Mais recente primeiro

                for (const arquivo of backupsRotativos) {
                    try {
                        const caminhoBackup = path.join(this.PASTA_BACKUP, arquivo);
                        const dadosBackup = await fs.readFile(caminhoBackup, 'utf8');
                        const backup = JSON.parse(dadosBackup);

                        if (backup.clientes && typeof backup.clientes === 'object') {
                            this.clientesAtivos = backup.clientes;
                            if (backup.historico && Array.isArray(backup.historico)) {
                                this.historicoRenovacoes = backup.historico;
                            }
                            console.log(`✅ Backup rotativo de pacotes restaurado (${arquivo}): ${Object.keys(this.clientesAtivos).length} clientes`);
                            await this.salvarDados();
                            return true;
                        }
                    } catch (error) {
                        console.log(`⚠️ Backup ${arquivo} corrompido, tentando próximo...`);
                        continue;
                    }
                }
            } catch (error) {
                console.log('⚠️ Erro ao acessar backups rotativos de pacotes:', error.message);
            }

            console.log('❌ Nenhum backup válido de pacotes encontrado');
            return false;

        } catch (error) {
            console.error('❌ Erro ao restaurar backup de pacotes:', error.message);
            return false;
        }
    }

    // Limpar backups antigos de pacotes
    async limparBackupsAntigosPacotes() {
        try {
            const arquivos = await fs.readdir(this.PASTA_BACKUP);
            const agora = new Date();
            const limiteDias = 7 * 24 * 60 * 60 * 1000; // 7 dias

            const backupsRotativos = arquivos.filter(arquivo =>
                arquivo.startsWith('dados_pacotes_backup_') && arquivo.endsWith('.json')
            );

            for (const arquivo of backupsRotativos) {
                try {
                    const caminhoArquivo = path.join(this.PASTA_BACKUP, arquivo);
                    const stats = await fs.stat(caminhoArquivo);
                    const idadeArquivo = agora - stats.mtime;

                    if (idadeArquivo > limiteDias) {
                        await fs.unlink(caminhoArquivo);
                        console.log(`🗑️ Backup antigo de pacotes removido: ${arquivo}`);
                    }
                } catch (error) {
                    console.log(`⚠️ Erro ao processar backup de pacotes ${arquivo}:`, error.message);
                }
            }

        } catch (error) {
            console.log('⚠️ Erro ao limpar backups antigos de pacotes:', error.message);
        }
    }
}

module.exports = SistemaPacotes;