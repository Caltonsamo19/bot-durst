const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

class SistemaRelatorios {
    constructor(client, googleSheetsConfig, pagamentosConfig) {
        this.client = client;
        this.configPedidos = googleSheetsConfig; // Script de pedidos
        this.configPagamentos = pagamentosConfig; // Script de pagamentos
        this.isRunning = false;

        // Configuração de números para relatórios por grupo
        this.numerosRelatorio = {};

        // Preços de revenda por grupo (MT por GB)
        this.precosRevenda = {};

        // Arquivo de persistência
        this.arquivoConfig = path.join(__dirname, 'config_relatorios.json');

        // Preço fixo de compra (MT por GB)
        this.PRECO_COMPRA = 12;
    }

    /**
     * Carrega configurações salvas do arquivo
     */
    async carregarConfiguracoes() {
        try {
            const data = await fs.readFile(this.arquivoConfig, 'utf8');
            const config = JSON.parse(data);
            this.numerosRelatorio = config.numerosRelatorio || config; // Retrocompatibilidade
            this.precosRevenda = config.precosRevenda || {};
            console.log(`✅ Carregadas ${Object.keys(this.numerosRelatorio).length} configurações de relatórios`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('📋 Nenhuma configuração de relatórios encontrada - iniciando vazio');
            } else {
                console.error('❌ Erro ao carregar configurações de relatórios:', error.message);
            }
        }
    }

    /**
     * Salva configurações no arquivo
     */
    async salvarConfiguracoes() {
        try {
            const config = {
                numerosRelatorio: this.numerosRelatorio,
                precosRevenda: this.precosRevenda
            };
            await fs.writeFile(this.arquivoConfig, JSON.stringify(config, null, 2));
            console.log(`💾 Salvas ${Object.keys(this.numerosRelatorio).length} configurações de relatórios`);
        } catch (error) {
            console.error('❌ Erro ao salvar configurações de relatórios:', error.message);
        }
    }

    /**
     * Configura número de relatório para um grupo (com persistência)
     * @param {string} grupoId - ID do grupo
     * @param {string} numeroRelatorio - Número para receber relatórios (com 258)
     * @param {string} grupoNome - Nome do grupo
     * @param {number} precoRevenda - Preço de revenda em MT/GB (16-18)
     */
    async configurarNumeroRelatorio(grupoId, numeroRelatorio, grupoNome = 'Grupo', precoRevenda = 16) {
        this.numerosRelatorio[grupoId] = numeroRelatorio;
        this.precosRevenda[grupoId] = precoRevenda;
        console.log(`💾 DEBUG: Salvando - Grupo: ${grupoId}, Preço: ${precoRevenda} MT/GB`);
        console.log(`💾 DEBUG: precosRevenda objeto:`, this.precosRevenda);
        await this.salvarConfiguracoes();
        console.log(`✅ Configurado relatório do grupo ${grupoNome} (${grupoId}) para ${numeroRelatorio} - Preço: ${precoRevenda} MT/GB`);

        // Enviar mensagem de confirmação no privado
        try {
            const numeroFormatado = numeroRelatorio + '@c.us';
            const lucroEstimado = precoRevenda - this.PRECO_COMPRA;
            const mensagem = `📊 *RELATÓRIOS ATIVADOS*\n\n` +
                `✅ Seu número foi vinculado para receber relatórios diários do grupo:\n\n` +
                `👥 *${grupoNome}*\n\n` +
                `🕙 Você receberá relatórios automáticos todos os dias às 22:00 com:\n` +
                `• Total de vendas (pedidos)\n` +
                `• Total de pagamentos confirmados\n` +
                `• Performance e estatísticas\n` +
                `• 💰 Lucro diário calculado\n\n` +
                `💸 *PREÇOS CONFIGURADOS:*\n` +
                `• Compra: ${this.PRECO_COMPRA} MT/GB\n` +
                `• Revenda: ${precoRevenda} MT/GB\n` +
                `• Lucro: ${lucroEstimado} MT/GB\n\n` +
                `🔔 Você também pode solicitar relatórios manuais a qualquer momento usando comandos no grupo.\n\n` +
                `✅ Configuração salva com sucesso!`;

            await this.client.sendMessage(numeroFormatado, mensagem);
            console.log(`📤 Mensagem de confirmação enviada para ${numeroRelatorio}`);
        } catch (error) {
            console.error(`❌ Erro ao enviar mensagem de confirmação para ${numeroRelatorio}:`, error.message);
        }

        return true;
    }

    /**
     * Remove configuração de número de relatório
     * @param {string} grupoId - ID do grupo
     */
    async removerNumeroRelatorio(grupoId) {
        delete this.numerosRelatorio[grupoId];
        await this.salvarConfiguracoes();
        console.log(`❌ Removido relatório do grupo ${grupoId}`);
    }

    /**
     * Lista configurações atuais
     */
    listarConfiguracoes() {
        console.log('📋 Configurações de relatórios:');
        for (const [grupoId, numero] of Object.entries(this.numerosRelatorio)) {
            console.log(`  ${grupoId} → ${numero}`);
        }
    }

    /**
     * Verifica se número existe no mapeamento
     * @param {string} numero - Número com 258
     * @param {Object} mapeamentoIDs - Objeto de mapeamento LID
     * @returns {boolean}
     */
    validarNumeroNoMapeamento(numero, mapeamentoIDs) {
        // Verificar se o número existe como valor no mapeamento
        const numeroFormatado = numero + '@c.us';
        const numerosValidos = Object.values(mapeamentoIDs);
        return numerosValidos.includes(numeroFormatado);
    }

    /**
     * Calcula período das últimas 24 horas
     */
    calcularPeriodo24h() {
        const agora = new Date();
        const fim = new Date(agora);
        const inicio = new Date(agora);
        inicio.setHours(inicio.getHours() - 24); // 24 horas atrás

        return {
            inicio: inicio.toISOString(),
            fim: fim.toISOString(),
            inicioFormatado: inicio.toLocaleDateString('pt-BR') + ' ' + inicio.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
            fimFormatado: fim.toLocaleDateString('pt-BR') + ' ' + fim.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        };
    }

    /**
     * Busca pedidos das últimas 24h para um grupo
     * @param {string} grupoId - ID do grupo
     * @param {Object} periodo - Período de busca
     */
    async buscarPedidos24h(grupoId, periodo) {
        try {
            console.log(`📦 Buscando pedidos 24h para grupo: ${grupoId}`);

            // Tentar buscar com função específica (precisa implementar no Google Scripts)
            const response = await axios.post(this.configPedidos.scriptUrl, {
                action: "buscar_pedidos_24h",
                grupo_id: grupoId,
                data_inicio: periodo.inicio,
                data_fim: periodo.fim
            }, {
                timeout: this.configPedidos.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.pedidos) {
                return {
                    pedidos: response.data.pedidos,
                    total: response.data.total || response.data.pedidos.length
                };
            }

        } catch (error) {
            console.log('⚠️ Função específica não encontrada, usando fallback...');
        }

        // Fallback: usar função existente (limitação: só pega pendentes)
        try {
            const response = await axios.post(this.configPedidos.scriptUrl, {
                action: "buscar_pendentes",
                grupo_id: grupoId
            }, {
                timeout: this.configPedidos.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.dados) {
                console.log('⚠️ Usando dados pendentes como aproximação (implementar busca 24h no Google Scripts)');
                return {
                    pedidos: response.data.dados,
                    total: response.data.total || response.data.dados.length,
                    fallback: true
                };
            }

        } catch (fallbackError) {
            console.error('❌ Erro ao buscar pedidos:', fallbackError.message);
        }

        return { pedidos: [], total: 0, error: true };
    }

    /**
     * Busca pagamentos das últimas 24h para um grupo
     * @param {string} grupoId - ID do grupo
     * @param {Object} periodo - Período de busca
     */
    async buscarPagamentos24h(grupoId, periodo) {
        try {
            console.log(`💰 Buscando pagamentos 24h para grupo: ${grupoId}`);

            // Tentar buscar com função específica (precisa implementar no Google Scripts)
            const response = await axios.post(this.configPagamentos.scriptUrl, {
                action: "buscar_pagamentos_24h",
                grupo_id: grupoId,
                data_inicio: periodo.inicio,
                data_fim: periodo.fim
            }, {
                timeout: this.configPagamentos.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.pagamentos) {
                return {
                    pagamentos: response.data.pagamentos,
                    total: response.data.total || response.data.pagamentos.length
                };
            }

        } catch (error) {
            console.log('⚠️ Função específica de pagamentos não encontrada, usando fallback...');
        }

        // Fallback: usar função existente (limitação: só pega pendentes)
        try {
            const response = await axios.post(this.configPagamentos.scriptUrl, {
                action: "buscar_pendentes",
                grupo_id: grupoId
            }, {
                timeout: this.configPagamentos.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.dados) {
                console.log('⚠️ Usando dados pendentes de pagamentos como aproximação');
                return {
                    pagamentos: response.data.dados,
                    total: response.data.total || response.data.dados.length,
                    fallback: true
                };
            }

        } catch (fallbackError) {
            console.error('❌ Erro ao buscar pagamentos:', fallbackError.message);
        }

        return { pagamentos: [], total: 0, error: true };
    }

    /**
     * Processa e cruza dados de pedidos e pagamentos
     * @param {Array} pedidos - Array de pedidos no formato REF|MEGAS|NUMERO
     * @param {Array} pagamentos - Array de pagamentos no formato REF|VALOR|NUMERO
     * @param {number} precoRevenda - Preço de revenda do grupo (MT/GB)
     */
    processarDadosCombinados(pedidos, pagamentos, precoRevenda = 16) {
        const resultado = {
            totalPedidos: pedidos.length,
            totalGigas: 0,
            pagamentosConfirmados: 0,
            totalArrecadado: 0,
            pedidosPendentes: 0,
            valorPendente: 0,
            custoTotal: 0,
            lucroTotal: 0,
            detalhes: []
        };

        // Criar mapa de pagamentos por referência
        const mapPagamentos = new Map();
        pagamentos.forEach(pagamento => {
            try {
                const partes = pagamento.split('|');
                if (partes.length >= 3) {
                    const referencia = partes[0];
                    const valor = parseFloat(partes[1]) || 0;
                    mapPagamentos.set(referencia, valor);
                }
            } catch (error) {
                console.error('⚠️ Erro ao processar pagamento:', pagamento);
            }
        });

        // Processar pedidos e cruzar com pagamentos
        pedidos.forEach(pedido => {
            try {
                const partes = pedido.split('|');
                if (partes.length >= 3) {
                    const referencia = partes[0];
                    const megas = parseInt(partes[1]) || 0;
                    const numero = partes[2];

                    // Converter megas para gigas
                    const gigas = megas / 1024;
                    resultado.totalGigas += gigas;

                    // Verificar se tem pagamento
                    const valorPagamento = mapPagamentos.get(referencia);

                    if (valorPagamento) {
                        resultado.pagamentosConfirmados++;
                        resultado.totalArrecadado += valorPagamento;
                    } else {
                        resultado.pedidosPendentes++;
                        // Estimar valor pendente (ajustar conforme sua lógica)
                        const valorEstimado = this.calcularValorPorMegas(megas);
                        resultado.valorPendente += valorEstimado;
                    }

                    resultado.detalhes.push({
                        referencia,
                        megas,
                        gigas: parseFloat(gigas.toFixed(2)),
                        numero,
                        pagamento: valorPagamento || 0,
                        status: valorPagamento ? 'PAGO' : 'PENDENTE'
                    });
                }
            } catch (error) {
                console.error('⚠️ Erro ao processar pedido:', pedido);
            }
        });

        // Calcular custos e lucros baseado apenas nos megas vendidos
        resultado.custoTotal = Math.round(resultado.totalGigas * this.PRECO_COMPRA);
        const receitaTotalVendas = Math.round(resultado.totalGigas * precoRevenda);
        resultado.lucroTotal = receitaTotalVendas - resultado.custoTotal;

        // Arredondar valores
        resultado.totalGigas = parseFloat(resultado.totalGigas.toFixed(2));
        resultado.totalArrecadado = Math.round(resultado.totalArrecadado);
        resultado.valorPendente = Math.round(resultado.valorPendente);

        return resultado;
    }

    /**
     * Calcula valor estimado por megas (ajustar conforme tabela de preços)
     */
    calcularValorPorMegas(megas) {
        // Tabela de preços estimada - AJUSTAR CONFORME SUA REALIDADE
        if (megas >= 10240) return Math.floor(megas / 8.5);   // 10GB+
        if (megas >= 5120) return Math.floor(megas / 8.2);    // 5GB+
        if (megas >= 2048) return Math.floor(megas / 8.0);    // 2GB+
        if (megas >= 1024) return Math.floor(megas / 7.5);    // 1GB+
        return Math.floor(megas / 7.0); // Padrão
    }

    /**
     * Gera texto do relatório
     * @param {Object} dados - Dados processados
     * @param {string} grupoNome - Nome do grupo
     * @param {Object} periodo - Período do relatório
     * @param {number} precoRevenda - Preço de revenda do grupo (MT/GB)
     */
    gerarTextoRelatorio(dados, grupoNome, periodo, precoRevenda = 16) {
        let texto = `📊*RELATÓRIO 24H - ${grupoNome}*\n`;
        texto += `📅Período: ${periodo.inicioFormatado} - ${periodo.fimFormatado}\n\n`;

        // Seção Vendas
        texto += `*📦VENDAS*\n`;
        texto += `✅Pedidos realizados: ${dados.totalPedidos}\n`;
        texto += `🌐Total gigas vendidos: ${dados.totalGigas} GB\n`;
        texto += `💵 Total recebido: ${dados.totalArrecadado.toLocaleString('pt-BR')} MT\n\n`;

        // Seção Lucro (só se houver vendas)
        if (dados.totalGigas > 0) {
            const lucroPorGiga = precoRevenda - this.PRECO_COMPRA;
            const receitaTotalVendas = Math.round(dados.totalGigas * precoRevenda);

            texto += `*💰LUCROS*\n`;
            texto += `📥Custo total: ${dados.custoTotal.toLocaleString('pt-BR')} MT (${this.PRECO_COMPRA} MT/GB)\n`;
            texto += `📤Receita total: ${receitaTotalVendas.toLocaleString('pt-BR')} MT (${precoRevenda} MT/GB)\n`;
            texto += `💚Lucro líquido: ${dados.lucroTotal.toLocaleString('pt-BR')} MT (${lucroPorGiga} MT/GB)\n\n`;
        }

        texto += `\n*🤖Relatório automático*\n`;
        texto += `_Powered by NeuroByte✅_`;

        return texto;
    }

    /**
     * Gera relatório para um grupo específico
     * @param {string} grupoId - ID do grupo
     * @param {string} grupoNome - Nome do grupo
     */
    async gerarRelatorioGrupo(grupoId, grupoNome = 'Grupo') {
        try {
            console.log(`📊 Gerando relatório 24h para: ${grupoNome} (${grupoId})`);

            const periodo = this.calcularPeriodo24h();

            // Buscar preço de revenda do grupo (padrão 16 MT/GB)
            const precoRevenda = this.precosRevenda[grupoId] || 16;
            console.log(`💰 DEBUG: Preço de revenda para grupo ${grupoId}: ${precoRevenda} MT/GB`);

            // Buscar dados das duas planilhas
            const [resultadoPedidos, resultadoPagamentos] = await Promise.all([
                this.buscarPedidos24h(grupoId, periodo),
                this.buscarPagamentos24h(grupoId, periodo)
            ]);

            // Processar dados combinados
            const dados = this.processarDadosCombinados(
                resultadoPedidos.pedidos,
                resultadoPagamentos.pagamentos,
                precoRevenda
            );

            // Gerar texto do relatório
            const textoRelatorio = this.gerarTextoRelatorio(dados, grupoNome, periodo, precoRevenda);

            // Verificar se tem número configurado para este grupo
            const numeroRelatorio = this.numerosRelatorio[grupoId];

            if (!numeroRelatorio) {
                console.log(`⚠️ Nenhum número configurado para relatórios do grupo ${grupoNome}`);
                return false;
            }

            // Enviar relatório para número privado
            await this.client.sendMessage(numeroRelatorio + '@c.us', textoRelatorio);

            console.log(`✅ Relatório enviado para ${numeroRelatorio} (grupo: ${grupoNome})`);

            // Log com alertas se houver fallbacks
            if (resultadoPedidos.fallback || resultadoPagamentos.fallback) {
                console.log('⚠️ Relatório gerado com limitações - implementar busca 24h no Google Scripts');
            }

            return true;

        } catch (error) {
            console.error(`❌ Erro ao gerar relatório para ${grupoNome}:`, error.message);
            return false;
        }
    }

    /**
     * Executa relatórios para todos os grupos configurados
     */
    async executarTodosRelatorios() {
        if (this.isRunning) {
            console.log('⚠️ Relatórios já estão sendo executados, pulando...');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Iniciando geração de relatórios 24h...');

        try {
            const gruposConfiguratos = Object.keys(this.numerosRelatorio);

            if (gruposConfiguratos.length === 0) {
                console.log('⚠️ Nenhum grupo configurado para relatórios');
                return;
            }

            console.log(`📋 Processando ${gruposConfiguratos.length} grupos configurados`);

            // Buscar informações dos grupos
            const chats = await this.client.getChats();
            const mapaGrupos = new Map();

            chats.filter(chat => chat.isGroup).forEach(grupo => {
                mapaGrupos.set(grupo.id._serialized, grupo.name || 'Grupo sem nome');
            });

            let sucessos = 0;
            let falhas = 0;

            for (const grupoId of gruposConfiguratos) {
                try {
                    const nomeGrupo = mapaGrupos.get(grupoId) || 'Grupo Desconhecido';

                    await this.gerarRelatorioGrupo(grupoId, nomeGrupo);
                    sucessos++;

                    // Pausa entre relatórios
                    await new Promise(resolve => setTimeout(resolve, 3000));

                } catch (error) {
                    console.error(`❌ Falha no grupo ${grupoId}:`, error.message);
                    falhas++;
                }
            }

            console.log(`✅ Relatórios concluídos! Sucessos: ${sucessos}, Falhas: ${falhas}`);

        } catch (error) {
            console.error('❌ Erro geral nos relatórios:', error.message);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Configura agendamento diário às 22h
     */
    iniciarAgendamento() {
        console.log('⏰ Configurando agendamento de relatórios às 22:00...');

        const job = cron.schedule('0 22 * * *', async () => {
            console.log('🕙 Executando relatórios agendados (22:00)...');
            await this.executarTodosRelatorios();
        }, {
            scheduled: false,
            timezone: "Africa/Maputo"
        });

        job.start();

        console.log('✅ Agendamento configurado! Relatórios às 22:00 (Maputo)');
        console.log(`📱 Grupos configurados: ${Object.keys(this.numerosRelatorio).length}`);

        return job;
    }

    /**
     * Teste manual de relatório
     * @param {string} grupoId - ID do grupo (opcional)
     */
    async testarRelatorio(grupoId = null) {
        console.log('🧪 Testando sistema de relatórios...');

        if (grupoId) {
            const chats = await this.client.getChats();
            const grupo = chats.find(chat => chat.id._serialized === grupoId);
            const nomeGrupo = grupo ? grupo.name : 'Grupo de Teste';

            await this.gerarRelatorioGrupo(grupoId, nomeGrupo);
        } else {
            await this.executarTodosRelatorios();
        }
    }
}

module.exports = SistemaRelatorios;