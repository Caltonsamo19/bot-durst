const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class SistemaPacotes {
    constructor() {
        console.log('📦 Inicializando Sistema de Pacotes Automáticos...');
        
        // Configurações da API MariaDB (substitui Google Sheets)
        this.PLANILHAS = {
            // PEDIDOS: API MariaDB local
            PEDIDOS: process.env.API_PEDIDOS_URL || 'http://localhost:3002/api/pedidos',
            // PAGAMENTOS: API MariaDB local
            PAGAMENTOS: process.env.API_PAGAMENTOS_URL || 'http://localhost:3002/api/pagamentos'
        };

        // API de Pacotes MariaDB
        this.API_PACOTES_URL = process.env.API_PACOTES_URL || 'http://localhost:3002/api/pacotes';
        this.timeout = 5000;
        
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
        
        // Carregar dados persistidos
        this.carregarDados();
        
        // Iniciar verificação automática
        this.iniciarVerificacaoAutomatica();
    }
    
    // === CARREGAR DADOS DO MARIADB ===
    async carregarDados() {
        try {
            // Tentar carregar do MariaDB primeiro
            try {
                const response = await axios.get(`${this.API_PACOTES_URL}/ativos`, {
                    timeout: this.timeout
                });

                if (response.data.success && response.data.pacotes) {
                    // Converter array para objeto indexado por cliente_id
                    this.clientesAtivos = {};
                    for (const pacote of response.data.pacotes) {
                        this.clientesAtivos[pacote.cliente_id] = {
                            numero: pacote.numero,
                            referenciaOriginal: pacote.referencia_original,
                            grupoId: pacote.grupo_id,
                            tipoPacote: pacote.tipo_pacote,
                            diasTotal: pacote.dias_total,
                            diasRestantes: pacote.dias_restantes,
                            megasIniciais: pacote.megas_iniciais,
                            valorMTInicial: pacote.valor_mt_inicial,
                            dataInicio: pacote.data_inicio,
                            dataExpiracao: pacote.data_expiracao,
                            horaEnvioOriginal: pacote.hora_envio_original,
                            proximaRenovacao: pacote.proxima_renovacao,
                            renovacoes: pacote.renovacoes,
                            status: pacote.status,
                            ultimaRenovacao: pacote.ultima_renovacao
                        };
                    }
                    console.log(`📦 ${Object.keys(this.clientesAtivos).length} clientes ativos carregados do MariaDB`);
                }
            } catch (error) {
                console.log(`⚠️ PACOTES: Erro ao carregar do MariaDB, usando JSON: ${error.message}`);
                // Fallback para JSON
                try {
                    const dadosClientes = await fs.readFile(this.ARQUIVO_CLIENTES, 'utf8');
                    this.clientesAtivos = JSON.parse(dadosClientes);
                    console.log(`📦 ${Object.keys(this.clientesAtivos).length} clientes ativos carregados do JSON (fallback)`);
                } catch (err) {
                    console.log(`📦 Nenhum arquivo de clientes encontrado - iniciando limpo`);
                    this.clientesAtivos = {};
                }
            }

            // Carregar histórico (manter em memória, não precisa carregar do DB a cada vez)
            this.historicoRenovacoes = [];
            console.log(`📦 Histórico de renovações está no MariaDB`);

        } catch (error) {
            console.error(`❌ PACOTES: Erro ao carregar dados:`, error);
        }
    }
    
    // === SALVAR DADOS NO MARIADB ===
    async salvarDados() {
        try {
            // Salvar cada cliente no MariaDB
            for (const [clienteId, cliente] of Object.entries(this.clientesAtivos)) {
                try {
                    await axios.post(this.API_PACOTES_URL, {
                        cliente_id: clienteId,
                        numero: cliente.numero,
                        referencia_original: cliente.referenciaOriginal,
                        grupo_id: cliente.grupoId,
                        tipo_pacote: cliente.tipoPacote,
                        dias_total: cliente.diasTotal,
                        dias_restantes: cliente.diasRestantes,
                        megas_iniciais: cliente.megasIniciais,
                        valor_mt_inicial: cliente.valorMTInicial,
                        data_inicio: cliente.dataInicio,
                        data_expiracao: cliente.dataExpiracao,
                        hora_envio_original: cliente.horaEnvioOriginal,
                        proxima_renovacao: cliente.proximaRenovacao,
                        renovacoes: cliente.renovacoes,
                        status: cliente.status,
                        ultima_renovacao: cliente.ultimaRenovacao
                    }, {
                        timeout: this.timeout
                    });
                } catch (err) {
                    console.error(`❌ Erro ao salvar pacote ${clienteId} no MariaDB: ${err.message}`);
                }
            }

            console.log(`💾 PACOTES: Dados salvos no MariaDB - ${Object.keys(this.clientesAtivos).length} clientes ativos`);

        } catch (error) {
            console.error(`❌ PACOTES: Erro ao salvar dados:`, error);
            // Fallback: salvar em JSON
            try {
                await fs.writeFile(this.ARQUIVO_CLIENTES, JSON.stringify(this.clientesAtivos, null, 2));
                console.log(`💾 PACOTES: Dados salvos em JSON (fallback)`);
            } catch (err) {
                console.error(`❌ PACOTES: Erro ao salvar JSON: ${err.message}`);
            }
        }
    }

    // === SALVAR PACOTE INDIVIDUAL NO MARIADB ===
    async salvarPacoteMariaDB(clienteId, cliente) {
        try {
            await axios.post(this.API_PACOTES_URL, {
                cliente_id: clienteId,
                numero: cliente.numero,
                referencia_original: cliente.referenciaOriginal,
                grupo_id: cliente.grupoId,
                tipo_pacote: cliente.tipoPacote,
                dias_total: cliente.diasTotal,
                dias_restantes: cliente.diasRestantes,
                megas_iniciais: cliente.megasIniciais,
                valor_mt_inicial: cliente.valorMTInicial,
                data_inicio: cliente.dataInicio,
                data_expiracao: cliente.dataExpiracao,
                hora_envio_original: cliente.horaEnvioOriginal,
                proxima_renovacao: cliente.proximaRenovacao,
                renovacoes: cliente.renovacoes,
                status: cliente.status,
                ultima_renovacao: cliente.ultimaRenovacao
            }, {
                timeout: this.timeout
            });
        } catch (error) {
            console.error(`❌ Erro ao salvar pacote ${clienteId}: ${error.message}`);
        }
    }

    // === REGISTRAR RENOVAÇÃO NO MARIADB ===
    async registrarRenovacaoMariaDB(renovacao) {
        try {
            await axios.post(`${this.API_PACOTES_URL}/renovacao`, {
                cliente_id: renovacao.clienteId,
                numero: renovacao.numero,
                referencia_original: renovacao.referenciaOriginal,
                nova_referencia: renovacao.novaReferencia,
                dia: renovacao.dia,
                dias_restantes: renovacao.diasRestantes,
                proxima_renovacao: renovacao.proximaRenovacao,
                timestamp_renovacao: renovacao.timestamp,
                grupo_id: renovacao.grupoId
            }, {
                timeout: this.timeout
            });
        } catch (error) {
            console.error(`❌ Erro ao registrar renovação: ${error.message}`);
        }
    }
    
    // === CRIAR PACOTE (SEM VERIFICAÇÃO DE PAGAMENTO) ===
    async processarComprovante(referencia, numero, grupoId, tipoPacote, megasIniciais, valorMTInicial, modoManual = false) {
        try {
            console.log(`📦 Processando pacote: ${referencia} (Modo: ${modoManual ? 'MANUAL' : 'AUTOMÁTICO'})`);
            console.log(`   📊 Pacote inicial: ${megasIniciais}MB por ${valorMTInicial}MT`);

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
            const diasPacote = this.TIPOS_PACOTES[tipoPacote].dias;
            const dataExpiracao = new Date(agora.getTime() + (diasPacote * 24 * 60 * 60 * 1000));

            // 4. MODO AUTOMÁTICO: Criar primeiro PEDIDO e PAGAMENTO
            // MODO MANUAL: Pular criação (admin já enviou manualmente)
            if (!modoManual) {
                console.log(`📦 Criando pacote inicial: ${referencia} (${megasIniciais}MB - ${valorMTInicial}MT)`);

                // Criar PEDIDO na planilha de pedidos (PACOTE ORIGINAL)
                await this.criarPedidoPacote(referencia, megasIniciais, numero, grupoId, agora);

                // Criar PAGAMENTO na planilha de pagamentos (PACOTE ORIGINAL)
                await this.criarPagamentoPacote(referencia, valorMTInicial, numero, grupoId, agora);
            } else {
                console.log(`📦 Modo MANUAL: Pulando criação do pedido inicial (admin já enviou)`);
            }
            
            // 5. Registrar cliente no sistema
            const clienteId = `${numero}_${referencia}`;
            this.clientesAtivos[clienteId] = {
                numero: numero,
                referenciaOriginal: referencia,
                grupoId: grupoId,
                tipoPacote: tipoPacote,
                diasTotal: diasPacote,
                diasRestantes: diasPacote, // CORRIGIDO: Começa com dias totais (renovações ainda não iniciaram)
                megasIniciais: megasIniciais,
                valorMTInicial: valorMTInicial,
                dataInicio: agora.toISOString(),
                dataExpiracao: dataExpiracao.toISOString(),
                horaEnvioOriginal: agora.toISOString(),
                proximaRenovacao: this.calcularProximaRenovacao(agora),
                renovacoes: 0,
                status: 'ativo',
                ultimaRenovacao: agora.toISOString()
            };

            // 6. Salvar dados
            await this.salvarDados();

            console.log(`✅ Cliente ativado com ${this.TIPOS_PACOTES[tipoPacote].nome}`);

            let mensagem;

            if (modoManual) {
                // Modo manual: apenas confirma agendamento de renovações
                mensagem = `🎯 **RENOVAÇÕES AGENDADAS!**\n\n` +
                          `📱 **Número:** ${numero}\n` +
                          `📋 **Referência:** ${referencia}\n` +
                          `📅 **Período:** ${diasPacote} dias\n` +
                          `🔄 **Renovações automáticas:** ${diasPacote}x de 100MB (diárias, 2h antes do horário anterior)\n` +
                          `📅 **Expira em:** ${dataExpiracao.toLocaleDateString('pt-BR')}\n\n` +
                          `⚠️ **Lembrete:** Você deve ter enviado o pacote principal manualmente!\n\n` +
                          `💡 *Verifique a validade com: .validade ${numero}*`;
            } else {
                // Modo automático: confirma envio do pacote + renovações
                mensagem = `🎯 **PACOTE ${this.TIPOS_PACOTES[tipoPacote].nome} ATIVADO!**\n\n` +
                          `📱 **Número:** ${numero}\n` +
                          `📋 **Referência:** ${referencia}\n` +
                          `📅 **Duração:** ${diasPacote} dias\n` +
                          `📦 **Pacote inicial:** ${megasIniciais}MB (${valorMTInicial}MT) - ENVIADO AUTOMATICAMENTE\n` +
                          `🔄 **Renovações automáticas:** ${diasPacote}x de 100MB (diárias, 2h antes do horário anterior)\n` +
                          `📅 **Expira em:** ${dataExpiracao.toLocaleDateString('pt-BR')}\n\n` +
                          `💡 *Verifique a validade com: .validade ${numero}*`;
            }

            return {
                sucesso: true,
                cliente: this.clientesAtivos[clienteId],
                mensagem: mensagem
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
                // Se for erro de duplicata (qualquer status), apenas loga e continua
                if (response.data && response.data.duplicado) {
                    console.log(`⚠️ PACOTES: Pedido ${novaReferencia} já existe (Status: ${response.data.status_existente}) - pulando criação`);
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
            
            // Registrar no histórico (MariaDB)
            const renovacao = {
                clienteId: clienteId,
                numero: cliente.numero,
                referenciaOriginal: cliente.referenciaOriginal,
                novaReferencia: novaReferencia,
                dia: diaAtual + 1,
                diasRestantes: cliente.diasRestantes,
                proximaRenovacao: cliente.proximaRenovacao,
                timestamp: agora.toISOString(),
                grupoId: cliente.grupoId
            };
            this.historicoRenovacoes.push(renovacao);

            // Salvar renovação no MariaDB
            await this.registrarRenovacaoMariaDB(renovacao);

            // Salvar pacote atualizado no MariaDB
            await this.salvarPacoteMariaDB(clienteId, cliente);
            
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

    // === EXTRAIR PACOTES RENOVÁVEIS DA TABELA ===
    extrairPacotesRenovaveis(tabelaTexto) {
        try {
            const pacotesRenovaveis = {
                '3': [],
                '5': [],
                '15': []
            };

            if (!tabelaTexto) {
                console.log('⚠️ PACOTES: Tabela vazia - nenhum pacote renovável encontrado');
                return pacotesRenovaveis;
            }

            // Dividir a tabela em linhas
            const linhas = tabelaTexto.split('\n');

            let secaoAtual = null;

            for (const linha of linhas) {
                const linhaTrim = linha.trim();

                // Detectar seções de pacotes renováveis
                // IMPORTANTE: Verificar 15 dias ANTES de 5 dias (15 contém "5 Dias")
                if (linhaTrim.includes('15 Dias') && linhaTrim.includes('Renováveis')) {
                    secaoAtual = '15';
                    continue;
                } else if (linhaTrim.includes('5 Dias') && linhaTrim.includes('Renováveis')) {
                    secaoAtual = '5';
                    continue;
                } else if (linhaTrim.includes('3 Dias') && linhaTrim.includes('Renováveis')) {
                    secaoAtual = '3';
                    continue;
                }

                // Resetar seção quando encontrar outras seções ou linhas de bônus
                if (linhaTrim.includes('PACOTES MENSAIS') ||
                    linhaTrim.includes('DIAMANTE') ||
                    linhaTrim.includes('PACOTES DIÁRIOS') ||
                    linhaTrim.includes('Bônus:') ||
                    linhaTrim.includes('🔄') ||
                    linhaTrim.startsWith('📍')) {
                    secaoAtual = null;
                    continue;
                }

                // Extrair pacotes no formato: 2000MB = 44MT
                if (secaoAtual && linhaTrim.match(/(\d+)MB\s*=\s*(\d+)MT/)) {
                    const match = linhaTrim.match(/(\d+)MB\s*=\s*(\d+)MT/);
                    if (match) {
                        const mb = parseInt(match[1]);
                        const valor = parseInt(match[2]);

                        pacotesRenovaveis[secaoAtual].push({ mb, valor });
                    }
                }

                // Também suportar formato com GB: 10GB = 219MT -> converter para MB
                if (secaoAtual && linhaTrim.match(/(\d+(?:\.\d+)?)GB\s*=\s*(\d+)MT/)) {
                    const match = linhaTrim.match(/(\d+(?:\.\d+)?)GB\s*=\s*(\d+)MT/);
                    if (match) {
                        const gb = parseFloat(match[1]);
                        const mb = Math.round(gb * 1024); // Converter GB para MB
                        const valor = parseInt(match[2]);

                        pacotesRenovaveis[secaoAtual].push({ mb, valor });
                    }
                }
            }

            // Log dos pacotes encontrados
            console.log('📦 PACOTES RENOVÁVEIS EXTRAÍDOS:');
            for (const [tipo, pacotes] of Object.entries(pacotesRenovaveis)) {
                console.log(`   ${tipo} dias: ${pacotes.length} pacotes`);
            }

            return pacotesRenovaveis;

        } catch (error) {
            console.error('❌ PACOTES: Erro ao extrair pacotes renováveis:', error);
            return { '3': [], '5': [], '15': [] };
        }
    }
}

module.exports = SistemaPacotes;