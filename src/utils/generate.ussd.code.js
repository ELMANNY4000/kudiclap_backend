const generateUssdCode = () => {
  const randomNum = Math.floor(10000 + Math.random() * 90000);
  return `*388*${randomNum}#`;
};

module.exports = { generateUssdCode };