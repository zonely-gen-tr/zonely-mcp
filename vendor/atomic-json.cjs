const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

async function retryIO(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(400, 50 * 2 ** attempt)));
    }
  }
}

async function writeJSON(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await retryIO(() => fs.promises.mkdir(path.dirname(filename), { recursive: true }));
  try {
    await retryIO(() => fs.promises.writeFile(temporary, JSON.stringify(value), { flag: 'wx' }));
    await retryIO(() => fs.promises.rename(temporary, filename));
  } finally { try { await fs.promises.unlink(temporary); } catch {} }
}

module.exports = { retryIO, writeJSON };
