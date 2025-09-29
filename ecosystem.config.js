module.exports = {
  apps: [
    {
      name: "whatsapp-api",
      script: "src/app.js",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: "3002",
        API_KEY: "22c746590447e7311801c22c4d53736d569843ebf6da3cf8498354399fe2f2e2"
      }
    }
  ]
};
