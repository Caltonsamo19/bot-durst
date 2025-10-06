const axios = require('axios');
const cron = require('node-cron');

class SistemaRelatorios {
    constructor(client, googleSheetsConfig, pagamentosConfig) {
        this.client = client;
        this.configPedidos = googleSheetsConfig; // Script de pedidos
        this.configPagamentos = pagamentosConfig; // Script de pagamentos
        this.isRunning = false;

        // Configuração de números para relatórios por grupo
        // AJUSTE ESTES NÚMEROS CONFORME NECESSÁRIO
        this.numerosRelatorio = {
            // 'GRUPO_ID': 'NUMERO_WHATSAPP',
            // Exemplo:
            // '258820749141-1441573529@g.us': '258847123456',
            // 'outro_grupo_id@g.us': '258841234567'
        };
    }

    /**
     * Configura número de relatório para um grupo
     * @param {string} grupoId - ID do grupo
     * @param {string} numeroRelatorio - Número para receber relatórios
     */
    configurarNumeroRelatorio(grupoId, numeroRelatorio) {
        this.numerosRelatorio[grupoId] = numeroRelatorio;
        console.log(`✅ Configurado relatório do grupo ${grupoId} para ${numeroRelatorio}`);
    }

    /**
     * Remove configuração de número de relatório
     * @param {string} grupoId - ID do grupo
     */
    removerNumeroRelatorio(grupoId) {
        delete this.numerosRelatorio[grupoId];
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
     */
    processarDadosCombinados(pedidos, pagamentos) {
        const resultado = {
            totalPedidos: pedidos.length,
            totalGigas: 0,
            pagamentosConfirmados: 0,
            totalArrecadado: 0,
            pedidosPendentes: 0,
            valorPendente: 0,
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
     */
    gerarTextoRelatorio(dados, grupoNome, periodo) {
        let texto = `📊 *RELATÓRIO 24H* - ${grupoNome}\n`;
        texto += `📅 Período: ${periodo.inicioFormatado} - ${periodo.fimFormatado}\n`;
        texto += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        // Seção Vendas
        texto += `📦 *VENDAS (Últimas 24h):*\n`;
        if (dados.totalPedidos === 0) {
            texto += `❌ Nenhum pedido registrado\n\n`;
        } else {
            texto += `✅ Pedidos realizados: ${dados.totalPedidos}\n`;
            texto += `🌐 Total gigas vendidos: ${dados.totalGigas} GB\n\n`;
        }

        // Seção Pagamentos
        texto += `💰 *PAGAMENTOS (Últimas 24h):*\n`;
        if (dados.pagamentosConfirmados === 0) {
            texto += `❌ Nenhum pagamento confirmado\n`;
        } else {
            texto += `✅ Pagamentos confirmados: ${dados.pagamentosConfirmados}\n`;
            texto += `💵 Total recebido: ${dados.totalArrecadado.toLocaleString('pt-BR')} MT\n`;
        }

        if (dados.pedidosPendentes > 0) {
            texto += `⏳ Pendentes: ${dados.pedidosPendentes} pedidos (≈${dados.valorPendente.toLocaleString('pt-BR')} MT)\n`;
        }
        texto += `\n`;

        // Seção Performance (só se houver dados)
        if (dados.totalPedidos > 0) {
            const taxaConversao = Math.round((dados.pagamentosConfirmados / dados.totalPedidos) * 100);
            const ticketMedio = dados.pagamentosConfirmados > 0 ? Math.round(dados.totalArrecadado / dados.pagamentosConfirmados) : 0;
            const gigasPorVenda = dados.totalPedidos > 0 ? (dados.totalGigas / dados.totalPedidos).toFixed(2) : 0;

            texto += `📊 *PERFORMANCE:*\n`;
            texto += `📈 Taxa conversão: ${taxaConversao}% (${dados.pagamentosConfirmados}/${dados.totalPedidos})\n`;

            if (ticketMedio > 0) {
                texto += `💸 Ticket médio: ${ticketMedio.toLocaleString('pt-BR')} MT\n`;
            }

            texto += `🌐 Gigas por venda: ${gigasPorVenda} GB\n\n`;
        }

        texto += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        texto += `🤖 Relatório automático - ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

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

            // Buscar dados das duas planilhas
            const [resultadoPedidos, resultadoPagamentos] = await Promise.all([
                this.buscarPedidos24h(grupoId, periodo),
                this.buscarPagamentos24h(grupoId, periodo)
            ]);

            // Processar dados combinados
            const dados = this.processarDadosCombinados(
                resultadoPedidos.pedidos,
                resultadoPagamentos.pagamentos
            );

            // Gerar texto do relatório
            const textoRelatorio = this.gerarTextoRelatorio(dados, grupoNome, periodo);

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