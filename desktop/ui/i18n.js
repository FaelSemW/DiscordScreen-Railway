export const translations = {
  'pt-BR': {
    title: 'Discord Screen Railway',
    welcome: 'Bem-vindo ao Discord Screen Railway',
    serverStatus: 'Servidor Railway',
    discordStatus: 'Aplicação Discord',
    transmissionStatus: 'Transmissão',
    startTransmission: 'Iniciar Transmissão',
    changeApp: 'Alterar Aplicação',
    resetConfig: 'Redefinir Configurações',
    connected: 'Conectado',
    ready: 'Pronta',
    configured: 'Configurada',
  },
};

export function t(key, lang = 'pt-BR') {
  return translations[lang]?.[key] || key;
}
