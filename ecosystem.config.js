module.exports = {
  apps: [
    {
      name: 'attendance-system',
      script: 'server.js',
      instances: 'max',        // Use all available CPU cores (t2.micro = 1, burst to 2)
      exec_mode: 'cluster',    // Cluster mode for load balancing across cores
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      // Memory limit — restart if exceeds 450MB (t2.micro has 1GB total)
      max_memory_restart: '450M',
      // Logging
      error_file: '/var/log/pm2/attendance-error.log',
      out_file: '/var/log/pm2/attendance-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Watch for file changes (disabled in production)
      watch: false,
    },
  ],
};
