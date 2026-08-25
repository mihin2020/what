/**
 * Configuration pm2 — whatsapp-veille
 *
 * Le module `node:sqlite` est encore derriere un drapeau sur Node 22 LTS :
 * `--experimental-sqlite` est donc passe au runtime via `node_args`.
 *
 * Lancement :  pm2 start ecosystem.config.js
 * Demarrage au boot :  pm2 startup && pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'whatsapp-veille',
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'src/index.ts',
      node_args: '--experimental-sqlite',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      // Redemarrage automatique en cas de crash
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '60s',

      // Journaux separes stdout / stderr
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
