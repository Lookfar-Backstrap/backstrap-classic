module.exports = {
  db: {
    user: process.env.DB_USER || 'bs2user',
    name: process.env.DB_NAME || 'bs2',
    pass: process.env.DB_PASS || 'bs24u',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432'
  },
  s3: {
    bucket: '[YOUR BUCKET HERE]'
  }
};