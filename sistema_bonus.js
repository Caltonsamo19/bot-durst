const axios = require('axios');

/**
 * Sistema de Gestão de Bônus
 * Usa MariaDB via API para persistência
 */
class SistemaBonus {
    constructor() {
        console.log('💰 Inicializando Sistema de Bônus (MariaDB)...');

        // URL da API
        this.API_URL = process.env.API_BONUS_URL || 'http://5.182.33.81:3002/api/bonus';
        this.timeout = 5000;

        // Cache em memória para performance
        this.bonusSaldos = {};
        this.pedidosSaque = {};
        this.codigosReferencia = {};
        this.referenciasClientes = {};

        console.log('💰 Sistema de Bônus inicializado!');
    }

    // === CARREGAR DADOS DO MARIADB ===
    async carregarDados() {
        console.log('💰 Carregando dados de bônus do MariaDB...');

        try {
            // Verificar se API está disponível
            const response = await axios.get(`${this.API_URL}/estatisticas`, {
                timeout: this.timeout
            });

            if (response.data.success) {
                const stats = response.data.estatisticas;
                console.log(`💰 ${stats.total_clientes} clientes com saldo`);
                console.log(`💰 ${stats.saques_pendentes} saques pendentes`);
                console.log(`💰 ${stats.codigos_ativos} códigos ativos`);
                console.log('✅ Sistema de bônus conectado ao MariaDB!');
            }

        } catch (error) {
            console.error(`❌ BONUS: Erro ao conectar com MariaDB: ${error.message}`);
            console.log('⚠️ Sistema de bônus funcionará em modo limitado');
        }
    }

    // === SALVAR DADOS (compatibilidade - não faz nada pois MariaDB salva automaticamente) ===
    async salvarDados() {
        // MariaDB salva automaticamente, este método existe apenas para compatibilidade
        console.log('💾 BONUS: Dados salvos no MariaDB');
    }

    // === BUSCAR SALDO DE BÔNUS ===
    async buscarSaldo(clienteId) {
        try {
            const response = await axios.get(`${this.API_URL}/saldo/${encodeURIComponent(clienteId)}`, {
                timeout: this.timeout
            });

            if (response.data.success) {
                return {
                    saldo: response.data.saldo,
                    historicoSaques: [],
                    detalhesReferencias: response.data.detalhes || {}
                };
            }

            return null;

        } catch (error) {
            console.error(`❌ Erro ao buscar saldo: ${error.message}`);
            return null;
        }
    }

    // === ATUALIZAR SALDO ===
    async atualizarSaldo(clienteId, callback) {
        try {
            // Buscar saldo atual
            let saldoObj = await this.buscarSaldo(clienteId);

            if (!saldoObj) {
                saldoObj = {
                    saldo: 0,
                    historicoSaques: [],
                    detalhesReferencias: {}
                };
            }

            // Aplicar callback para modificar
            callback(saldoObj);

            // Salvar no MariaDB
            await axios.post(`${this.API_URL}/saldo`, {
                cliente_id: clienteId,
                saldo: saldoObj.saldo
            }, {
                timeout: this.timeout
            });

            console.log(`💰 Saldo de ${clienteId} atualizado: ${saldoObj.saldo}MB`);

        } catch (error) {
            console.error(`❌ Erro ao atualizar saldo: ${error.message}`);
        }
    }

    // === CRIAR PEDIDO DE SAQUE ===
    async criarPedidoSaque(referencia, cliente, nomeCliente, quantidade, numeroDestino, grupo) {
        try {
            const response = await axios.post(`${this.API_URL}/saque`, {
                referencia,
                cliente_id: cliente,
                nome_cliente: nomeCliente,
                quantidade,
                numero_destino: numeroDestino,
                grupo_id: grupo
            }, {
                timeout: this.timeout
            });

            if (response.data.success) {
                console.log(`💰 Pedido de saque criado: ${referencia}`);
                return {
                    referencia,
                    cliente,
                    nomeCliente,
                    quantidade,
                    numeroDestino,
                    dataSolicitacao: new Date().toISOString(),
                    status: 'pendente',
                    grupo
                };
            }

            return null;

        } catch (error) {
            console.error(`❌ Erro ao criar pedido de saque: ${error.message}`);
            return null;
        }
    }

    // === ATUALIZAR STATUS DO PEDIDO ===
    async atualizarStatusPedido(referencia, status, dadosAdicionais = {}) {
        try {
            const response = await axios.put(`${this.API_URL}/saque/${encodeURIComponent(referencia)}`, {
                status,
                erro_detalhes: dadosAdicionais.erroDetalhes || null
            }, {
                timeout: this.timeout
            });

            if (response.data.success) {
                console.log(`💰 Status do pedido ${referencia} atualizado para: ${status}`);
                return true;
            }

            return false;

        } catch (error) {
            console.error(`❌ Erro ao atualizar status do pedido: ${error.message}`);
            return false;
        }
    }

    // === REMOVER PEDIDO ===
    async removerPedido(referencia) {
        // Por segurança, apenas atualiza o status para cancelado
        return await this.atualizarStatusPedido(referencia, 'cancelado');
    }

    // === BUSCAR PEDIDO DE SAQUE ===
    async buscarPedidoSaque(referencia) {
        try {
            const response = await axios.get(`${this.API_URL}/saque/${encodeURIComponent(referencia)}`, {
                timeout: this.timeout
            });

            if (response.data.success) {
                return response.data.saque;
            }

            return null;

        } catch (error) {
            return null;
        }
    }

    // === CRIAR CÓDIGO DE REFERÊNCIA ===
    async criarCodigoReferencia(codigo, donoId) {
        try {
            const response = await axios.post(`${this.API_URL}/codigo`, {
                codigo,
                dono_id: donoId
            }, {
                timeout: this.timeout
            });

            if (response.data.success) {
                console.log(`💰 Código de referência criado: ${codigo}`);
                return true;
            }

            return false;

        } catch (error) {
            console.error(`❌ Erro ao criar código: ${error.message}`);
            return false;
        }
    }

    // === BUSCAR CÓDIGO ===
    async buscarCodigo(codigo) {
        try {
            const response = await axios.get(`${this.API_URL}/codigo/${encodeURIComponent(codigo)}`, {
                timeout: this.timeout
            });

            if (response.data.success && response.data.encontrado) {
                return response.data.codigo;
            }

            return null;

        } catch (error) {
            return null;
        }
    }

    // === REGISTRAR REFERÊNCIA ===
    async registrarReferencia(clienteId, convidadoPor, nomeConvidado) {
        try {
            const response = await axios.post(`${this.API_URL}/referencia`, {
                cliente_id: clienteId,
                convidado_por: convidadoPor,
                nome_convidado: nomeConvidado
            }, {
                timeout: this.timeout
            });

            if (response.data.success) {
                console.log(`💰 Referência registrada: ${clienteId} convidado por ${convidadoPor}`);
                return true;
            }

            return false;

        } catch (error) {
            console.error(`❌ Erro ao registrar referência: ${error.message}`);
            return false;
        }
    }

    // === BUSCAR REFERÊNCIA ===
    async buscarReferencia(clienteId) {
        try {
            const response = await axios.get(`${this.API_URL}/referencia/${encodeURIComponent(clienteId)}`, {
                timeout: this.timeout
            });

            if (response.data.success && response.data.encontrado) {
                return response.data.referencia;
            }

            return null;

        } catch (error) {
            return null;
        }
    }

    // === PROCESSAR BÔNUS DE COMPRA ===
    async processarBonusCompra(clienteId, megas) {
        try {
            const response = await axios.post(`${this.API_URL}/processar-compra`, {
                cliente_id: clienteId,
                megas
            }, {
                timeout: this.timeout
            });

            if (response.data.success && response.data.bonus_processado) {
                console.log(`💰 Bônus processado: ${response.data.bonus_mb}MB para ${response.data.convidador_id}`);
                return {
                    convidadorId: response.data.convidador_id,
                    bonusMB: response.data.bonus_mb,
                    comprasRealizadas: response.data.compras_realizadas
                };
            }

            return null;

        } catch (error) {
            console.error(`❌ Erro ao processar bônus: ${error.message}`);
            return null;
        }
    }

    // === ESTATÍSTICAS ===
    async obterEstatisticas() {
        try {
            const response = await axios.get(`${this.API_URL}/estatisticas`, {
                timeout: this.timeout
            });

            if (response.data.success) {
                return {
                    totalClientes: response.data.estatisticas.total_clientes,
                    totalSaques: response.data.estatisticas.saques_pendentes,
                    saldoTotal: response.data.estatisticas.saldo_total,
                    saldoMedio: response.data.estatisticas.total_clientes > 0
                        ? Math.round(response.data.estatisticas.saldo_total / response.data.estatisticas.total_clientes)
                        : 0
                };
            }

            return {
                totalClientes: 0,
                totalSaques: 0,
                saldoTotal: 0,
                saldoMedio: 0
            };

        } catch (error) {
            console.error(`❌ Erro ao obter estatísticas: ${error.message}`);
            return {
                totalClientes: 0,
                totalSaques: 0,
                saldoTotal: 0,
                saldoMedio: 0
            };
        }
    }

    // === LISTAR SAQUES PENDENTES ===
    async listarSaquesPendentes() {
        try {
            const response = await axios.get(`${this.API_URL}/saques/pendentes`, {
                timeout: this.timeout
            });

            if (response.data.success) {
                return response.data.saques;
            }

            return [];

        } catch (error) {
            console.error(`❌ Erro ao listar saques pendentes: ${error.message}`);
            return [];
        }
    }
}

module.exports = SistemaBonus;
