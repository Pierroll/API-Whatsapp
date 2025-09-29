module.exports = {
  apps: [
    {
      name: "whatsapp-api",
      script: "src/app.js",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: "3002",
        API_KEY: "22c746590447e7311801c22c4d53736d569843ebf6da3cf8498354399fe2f2e2",
                QR_LOGIN_USER: "wa-user-api",
        QR_LOGIN_PASS: "rollingcode",
        COOKIE_SECRET: "a4ae8dea65b7a6cbad1d2f74714321ceb6f7b11a2cee6d4b64881746a68cc225"
        
      }
    }
  ]
};
