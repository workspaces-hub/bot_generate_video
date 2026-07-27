module.exports = {
  apps: [{
    script: "dist/src/index.js",
    name: 'bot_generate',
    watch: false,
    // max_memory_restart: '5000M',
    autorestart: false,
    // exp_backoff_restart_delay: 100,
  }]
}