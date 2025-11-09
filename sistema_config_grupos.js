const fs = require('fs').promises;
const path = require('path');

/**
 * Sistema de Configuração Dinâmica de Grupos
 * Permite alterar tabelas de preços via WhatsApp
 */
class SistemaConfigGrupos {
    constructor() {
        console.log('⚙️ Inicializando Sistema de Configuração de Grupos...');

        this.ARQUIVO_CONFIG = path.join(__dirname, 'config_grupos.json');
        this.ARQUIVO_BACKUP = path.join(__dirname, 'config_grupos_backup.json');

        // Configurações em memória
        this.configGrupos = {};

        // Carregar configurações
        this.carregarConfiguracoes();

        console.log('⚙️ Sistema de Configuração inicializado!');
    }

    // === CARREGAR CONFIGURAÇÕES ===
    async carregarConfiguracoes() {
        try {
            const dados = await fs.readFile(this.ARQUIVO_CONFIG, 'utf8');
            this.configGrupos = JSON.parse(dados);
            console.log(`✅ Configurações carregadas: ${Object.keys(this.configGrupos).length} grupos`);
        } catch (error) {
            console.log('⚙️ Arquivo de configuração não existe, será criado ao salvar');
            this.configGrupos = {};
        }
    }

    // === SALVAR CONFIGURAÇÕES ===
    async salvarConfiguracoes() {
        try {
            // Criar backup antes de salvar
            await this.criarBackup();

            // Salvar nova configuração
            await fs.writeFile(
                this.ARQUIVO_CONFIG,
                JSON.stringify(this.configGrupos, null, 2)
            );

            console.log(`💾 Configurações salvas: ${Object.keys(this.configGrupos).length} grupos`);
            return true;
        } catch (error) {
            console.error('❌ Erro ao salvar configurações:', error);
            return false;
        }
    }

    // === CRIAR BACKUP ===
    async criarBackup() {
        try {
            // Verificar se arquivo existe antes de fazer backup
            try {
                await fs.access(this.ARQUIVO_CONFIG);
                const dados = await fs.readFile(this.ARQUIVO_CONFIG, 'utf8');
                await fs.writeFile(this.ARQUIVO_BACKUP, dados);
                console.log('💾 Backup criado com sucesso');
            } catch {
                console.log('ℹ️ Nenhum arquivo para backup (primeira configuração)');
            }
        } catch (error) {
            console.error('⚠️ Erro ao criar backup:', error.message);
        }
    }

    // === ATUALIZAR TABELA DE UM GRUPO ===
    async atualizarTabela(grupoId, novaTabela, atualizadoPor, grupoNome = null) {
        try {
            console.log(`📝 Atualizando tabela do grupo ${grupoId}`);

            // Validar tabela (verificar se tem preços)
            const temPrecos = /\d+\s*MT/i.test(novaTabela);
            if (!temPrecos) {
                return {
                    sucesso: false,
                    erro: 'Tabela inválida: nenhum preço encontrado (formato esperado: "10MT" ou "10 MT")'
                };
            }

            // Verificar tamanho mínimo
            if (novaTabela.length < 50) {
                return {
                    sucesso: false,
                    erro: 'Tabela muito curta. Deve conter pelo menos 50 caracteres.'
                };
            }

            // Inicializar config do grupo se não existe
            if (!this.configGrupos[grupoId]) {
                this.configGrupos[grupoId] = {
                    nome: grupoNome || 'Grupo',
                    tabela: '',
                    pagamento: '',
                    historico: []
                };
                console.log(`🆕 Grupo novo criado no sistema: ${grupoNome || grupoId}`);
            } else if (grupoNome && this.configGrupos[grupoId].nome !== grupoNome) {
                // Atualizar nome se mudou
                this.configGrupos[grupoId].nome = grupoNome;
                console.log(`📝 Nome do grupo atualizado para: ${grupoNome}`);
            }

            // Salvar versão anterior no histórico
            if (this.configGrupos[grupoId].tabela) {
                if (!this.configGrupos[grupoId].historico) {
                    this.configGrupos[grupoId].historico = [];
                }

                this.configGrupos[grupoId].historico.push({
                    tabela: this.configGrupos[grupoId].tabela,
                    alteradoEm: this.configGrupos[grupoId].ultimaAtualizacao || new Date().toISOString(),
                    alteradoPor: this.configGrupos[grupoId].atualizadoPor || 'Sistema'
                });

                // Manter apenas últimas 5 versões
                if (this.configGrupos[grupoId].historico.length > 5) {
                    this.configGrupos[grupoId].historico = this.configGrupos[grupoId].historico.slice(-5);
                }
            }

            // Atualizar tabela
            this.configGrupos[grupoId].tabela = novaTabela;
            this.configGrupos[grupoId].ultimaAtualizacao = new Date().toISOString();
            this.configGrupos[grupoId].atualizadoPor = atualizadoPor;

            // Salvar
            const salvou = await this.salvarConfiguracoes();

            if (salvou) {
                return {
                    sucesso: true,
                    mensagem: 'Tabela atualizada com sucesso!',
                    precosCont: this.contarPrecos(novaTabela)
                };
            } else {
                return {
                    sucesso: false,
                    erro: 'Erro ao salvar configuração'
                };
            }

        } catch (error) {
            console.error('❌ Erro ao atualizar tabela:', error);
            return {
                sucesso: false,
                erro: error.message
            };
        }
    }

    // === ATUALIZAR FORMA DE PAGAMENTO ===
    async atualizarPagamento(grupoId, novoPagamento, atualizadoPor) {
        try {
            console.log(`💳 Atualizando pagamento do grupo ${grupoId}`);

            // Validar (deve conter número de telefone)
            const temNumero = /\d{9,12}/.test(novoPagamento);
            if (!temNumero) {
                return {
                    sucesso: false,
                    erro: 'Forma de pagamento inválida: nenhum número encontrado'
                };
            }

            // Inicializar config do grupo se não existe
            if (!this.configGrupos[grupoId]) {
                this.configGrupos[grupoId] = {
                    nome: 'Grupo',
                    tabela: '',
                    pagamento: '',
                    historico: []
                };
            }

            // Atualizar
            this.configGrupos[grupoId].pagamento = novoPagamento;
            this.configGrupos[grupoId].ultimaAtualizacao = new Date().toISOString();
            this.configGrupos[grupoId].atualizadoPor = atualizadoPor;

            // Salvar
            const salvou = await this.salvarConfiguracoes();

            return salvou ?
                { sucesso: true, mensagem: 'Forma de pagamento atualizada!' } :
                { sucesso: false, erro: 'Erro ao salvar configuração' };

        } catch (error) {
            console.error('❌ Erro ao atualizar pagamento:', error);
            return { sucesso: false, erro: error.message };
        }
    }

    // === OBTER CONFIGURAÇÃO DE UM GRUPO ===
    obterConfig(grupoId) {
        return this.configGrupos[grupoId] || null;
    }

    // === CONTAR PREÇOS NA TABELA ===
    contarPrecos(tabela) {
        const matches = tabela.match(/\d+\s*(MB|GB)\s*=\s*\d+\s*MT/gi);
        return matches ? matches.length : 0;
    }

    // === RESTAURAR VERSÃO ANTERIOR ===
    async restaurarVersaoAnterior(grupoId, atualizadoPor) {
        try {
            const config = this.configGrupos[grupoId];

            if (!config || !config.historico || config.historico.length === 0) {
                return {
                    sucesso: false,
                    erro: 'Nenhuma versão anterior encontrada'
                };
            }

            // Pegar última versão do histórico
            const versaoAnterior = config.historico.pop();

            // Salvar versão atual no histórico antes de restaurar
            config.historico.push({
                tabela: config.tabela,
                alteradoEm: config.ultimaAtualizacao,
                alteradoPor: config.atualizadoPor
            });

            // Restaurar
            config.tabela = versaoAnterior.tabela;
            config.ultimaAtualizacao = new Date().toISOString();
            config.atualizadoPor = atualizadoPor;

            const salvou = await this.salvarConfiguracoes();

            return salvou ?
                { sucesso: true, mensagem: 'Versão anterior restaurada!' } :
                { sucesso: false, erro: 'Erro ao salvar configuração' };

        } catch (error) {
            console.error('❌ Erro ao restaurar versão:', error);
            return { sucesso: false, erro: error.message };
        }
    }

    // === VISUALIZAR HISTÓRICO ===
    obterHistorico(grupoId) {
        const config = this.configGrupos[grupoId];

        if (!config || !config.historico || config.historico.length === 0) {
            return {
                sucesso: false,
                mensagem: 'Nenhum histórico encontrado'
            };
        }

        return {
            sucesso: true,
            versoes: config.historico.length,
            historico: config.historico.map((v, i) => ({
                versao: i + 1,
                data: v.alteradoEm,
                por: v.alteradoPor
            }))
        };
    }

    // === MESCLAR COM CONFIGURAÇÃO PADRÃO ===
    mesclarComConfigPadrao(configPadrao) {
        // Para cada grupo no padrão, usar config salva se existir
        const configMesclada = {};

        for (const [grupoId, dadosPadrao] of Object.entries(configPadrao)) {
            if (this.configGrupos[grupoId]) {
                // Usar config salva, mas manter nome do padrão
                configMesclada[grupoId] = {
                    nome: dadosPadrao.nome, // Nome do código (sempre atualizado)
                    tabela: this.configGrupos[grupoId].tabela || dadosPadrao.tabela,
                    pagamento: this.configGrupos[grupoId].pagamento || dadosPadrao.pagamento,
                    ultimaAtualizacao: this.configGrupos[grupoId].ultimaAtualizacao,
                    atualizadoPor: this.configGrupos[grupoId].atualizadoPor
                };
            } else {
                // Usar padrão
                configMesclada[grupoId] = dadosPadrao;
            }
        }

        return configMesclada;
    }
}

module.exports = SistemaConfigGrupos;
