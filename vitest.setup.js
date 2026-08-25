process.env.NODE_ENV = 'test';

for (const chave of [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ADMIN_ID',
  'PUBLIC_ORIGIN',
]) {
  process.env[chave] = '';
}
process.env.SESSION_SECRET ??= 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
process.env.PORT ??= '0';
