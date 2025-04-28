const express = require('express');
const app = express();
const whatsappRoute = require('./routes/whatsappRoute');

app.use(express.json());
app.use('/api/whatsapp', whatsappRoute);

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
