module.exports = {
  apps: [
    {
      name: 'weblight-ops',
      script: 'npx',
      args: 'serve . --listen 3000',
      cwd: '/home/user/webapp',
      env: { PORT: 3000 },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
