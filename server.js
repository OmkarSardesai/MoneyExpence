const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'app-data.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'expense-tracker-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.use(express.static(path.join(__dirname, 'public')));

let pool;
let dbReady = false;
const memoryUsers = [];
let memoryUserId = 1;
const memoryExpenses = [];
let memoryExpenseId = 1;
const authTokens = {};

function ensureDataStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], expenses: [], nextUserId: 1, nextExpenseId: 1 }, null, 2));
  }
}

function loadDataStore() {
  ensureDataStore();
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
    memoryUsers.splice(0, memoryUsers.length, ...(saved.users || []));
    memoryExpenses.splice(0, memoryExpenses.length, ...(saved.expenses || []));
    memoryUserId = Number(saved.nextUserId || memoryUsers.length + 1);
    memoryExpenseId = Number(saved.nextExpenseId || memoryExpenses.length + 1);

    Object.keys(authTokens).forEach((token) => delete authTokens[token]);
    Object.entries(saved.authTokens || {}).forEach(([token, entry]) => {
      if (entry && entry.expiresAt && new Date(entry.expiresAt) > new Date()) {
        authTokens[token] = entry;
      }
    });
  } catch (err) {
    console.warn('Could not load persisted data. Starting with empty storage.', err.message);
  }
}

function saveDataStore() {
  ensureDataStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    users: memoryUsers,
    expenses: memoryExpenses,
    nextUserId: memoryUserId,
    nextExpenseId: memoryExpenseId,
    authTokens
  }, null, 2));
}

async function initDb() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const useSsl = process.env.DB_SSL === 'true' || process.env.DB_SSL === '1' || Boolean(dbUrl);

  try {
    if (dbUrl) {
      pool = mysql.createPool({
        uri: dbUrl,
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 0,
        ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {})
      });
    } else {
      const dbPassword = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'Omkar@2005';
      const dbConfig = {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: dbPassword,
        database: process.env.DB_NAME || 'expense_tracker',
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 0,
        ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {})
      };

      const isLocalHost = !process.env.DB_HOST || process.env.DB_HOST === 'localhost' || process.env.DB_HOST === '127.0.0.1';

      if (isLocalHost) {
        try {
          const initConfig = { ...dbConfig };
          delete initConfig.database;
          const tempPool = mysql.createPool(initConfig);
          const dbName = dbConfig.database.replace(/`/g, '``');
          await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
          await tempPool.end();
        } catch (createErr) {
          console.warn('Local database creation check skipped:', createErr.message);
        }
      }

      pool = mysql.createPool(dbConfig);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(150) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        category VARCHAR(50) NOT NULL,
        description TEXT,
        expense_date DATE NOT NULL,
        transaction_type VARCHAR(10) NOT NULL DEFAULT 'debit',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const [columns] = await pool.query(
      "SHOW COLUMNS FROM expenses LIKE 'transaction_type'"
    );
    if (columns.length === 0) {
      await pool.query(
        "ALTER TABLE expenses ADD COLUMN transaction_type VARCHAR(10) NOT NULL DEFAULT 'debit'"
      );
    }

    dbReady = true;
    console.log('Database connected and ready.');
  } catch (err) {
    dbReady = false;
    console.error('Database connection attempt failed:', err.message);
  }
}

async function ensureDbReady() {
  if (dbReady) return true;
  console.log('Attempting to re-establish database connection...');
  await initDb();
  return dbReady;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, pair) => {
    const [rawName, ...rawValue] = pair.trim().split('=');
    if (rawName) {
      acc[rawName] = decodeURIComponent(rawValue.join('='));
    }
    return acc;
  }, {});
}

function getAuthToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies.authToken || null;
}

function createAuthToken(userId, userName) {
  const token = crypto.randomBytes(24).toString('hex');
  authTokens[token] = {
    userId,
    userName,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  };
  saveDataStore();
  return token;
}

function clearAuthToken(req) {
  const token = getAuthToken(req);
  if (token) {
    delete authTokens[token];
    saveDataStore();
  }
}

function restoreUserFromToken(req) {
  const token = getAuthToken(req);
  if (!token) return null;
  const entry = authTokens[token];
  if (!entry) return null;
  if (new Date(entry.expiresAt) <= new Date()) {
    delete authTokens[token];
    saveDataStore();
    return null;
  }

  req.session.userId = Number(entry.userId);
  req.session.userName = entry.userName || '';
  return req.session.userId;
}

function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }

  const restoredUserId = restoreUserFromToken(req);
  if (restoredUserId) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }
  return res.redirect('/login.html');
}

function getMemoryUserByEmail(email) {
  return memoryUsers.find((user) => user.email.toLowerCase() === String(email).toLowerCase());
}

function getMemoryUserById(id) {
  return memoryUsers.find((user) => user.id === Number(id));
}

function getMemoryExpensesForUser(userId) {
  return memoryExpenses.filter((expense) => expense.userId === Number(userId));
}

function getMemorySummaryForUser(userId) {
  const userExpenses = getMemoryExpensesForUser(userId);
  const total = userExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const debitTotal = userExpenses.filter((item) => item.transactionType === 'debit').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const creditTotal = userExpenses.filter((item) => item.transactionType === 'credit').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const categories = Object.entries(userExpenses.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + Number(item.amount || 0);
    return acc;
  }, {})).map(([category, totalAmount]) => ({ category, total: totalAmount }));

  const monthly = Object.entries(userExpenses.reduce((acc, item) => {
    const month = item.expenseDate.slice(0, 7);
    acc[month] = (acc[month] || 0) + Number(item.amount || 0);
    return acc;
  }, {})).map(([month, totalAmount]) => ({ month, total: totalAmount })).sort((a, b) => a.month.localeCompare(b.month));

  const sortedExpenses = userExpenses.slice().sort((a, b) => b.expenseDate.localeCompare(a.expenseDate));

  return {
    total,
    debitTotal,
    creditTotal,
    categories: categories.sort((a, b) => b.total - a.total),
    monthly,
    recent: sortedExpenses.slice(0, 5),
    transactions: sortedExpenses,
    expenses: sortedExpenses
  };
}

async function getUserExpenses(userId) {
  await ensureDbReady();
  if (!dbReady) {
    return getMemoryExpensesForUser(userId)
      .slice()
      .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate))
      .map((item) => ({ ...item, transactionType: item.transactionType || item.transaction_type || 'debit' }));
  }

  const [rows] = await pool.query('SELECT * FROM expenses WHERE user_id = ? ORDER BY expense_date DESC, created_at DESC', [userId]);
  return rows.map((item) => ({ ...item, transactionType: item.transaction_type || 'debit' }));
}

async function getSummaryData(userId) {
  await ensureDbReady();
  if (!dbReady) {
    return getMemorySummaryForUser(userId);
  }

  const [totals] = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ?', [userId]);
  const [debitTotals] = await pool.query("SELECT COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) AS debit_total FROM expenses WHERE user_id = ?", [userId]);
  const [creditTotals] = await pool.query("SELECT COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) AS credit_total FROM expenses WHERE user_id = ?", [userId]);
  const [categories] = await pool.query('SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? GROUP BY category ORDER BY total DESC', [userId]);
  const [monthly] = await pool.query('SELECT DATE_FORMAT(expense_date, "%Y-%m") AS month, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? GROUP BY month ORDER BY month DESC LIMIT 6', [userId]);
  const [recent] = await pool.query('SELECT * FROM expenses WHERE user_id = ? ORDER BY expense_date DESC LIMIT 5', [userId]);
  const [rows] = await pool.query('SELECT * FROM expenses WHERE user_id = ? ORDER BY expense_date DESC, created_at DESC', [userId]);

  return {
    total: Number(totals[0].total || 0),
    debitTotal: Number(debitTotals[0].debit_total || 0),
    creditTotal: Number(creditTotals[0].credit_total || 0),
    categories,
    monthly: monthly.reverse(),
    recent: recent.map((item) => ({ ...item, transactionType: item.transaction_type || 'debit' })),
    expenses: rows.map((item) => ({ ...item, transactionType: item.transaction_type || 'debit' }))
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => res.redirect('/login.html'));
app.get('/register', (req, res) => res.redirect('/register.html'));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(fullName).trim();

    await ensureDbReady();

    if (!dbReady) {
      const existingUser = getMemoryUserByEmail(cleanEmail);
      if (existingUser) {
        return res.status(409).json({ message: 'An account with this email already exists.' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      memoryUsers.push({
        id: memoryUserId++,
        full_name: cleanName,
        email: cleanEmail,
        password: hashedPassword,
        created_at: new Date().toISOString()
      });
      saveDataStore();
      return res.status(201).json({ message: 'Account created. Please log in.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)',
      [cleanName, cleanEmail, hashedPassword]
    );

    res.status(201).json({ message: 'Account created. Please log in.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Please enter your email and password.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    await ensureDbReady();

    if (!dbReady) {
      const user = getMemoryUserByEmail(cleanEmail);
      if (!user) {
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials.' });
      }

      req.session.userId = user.id;
      req.session.userName = user.full_name;
      const token = createAuthToken(user.id, user.full_name);
      res.cookie('authToken', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      return res.json({ message: 'Login successful.', user: { id: user.id, name: user.full_name, email: user.email } });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [cleanEmail]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    req.session.userId = user.id;
    req.session.userName = user.full_name;
    const token = createAuthToken(user.id, user.full_name);
    res.cookie('authToken', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ message: 'Login successful.', user: { id: user.id, name: user.full_name, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthToken(req);
  req.session.destroy(() => {
    res.clearCookie('authToken');
    res.json({ message: 'Logged out.' });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    const restoredUserId = restoreUserFromToken(req);
    if (!restoredUserId) {
      return res.status(401).json({ message: 'Unauthorized.' });
    }
  }

  if (!dbReady) {
    const user = getMemoryUserById(req.session.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    return res.json({ user: { id: user.id, full_name: user.full_name, email: user.email } });
  }

  try {
    const [rows] = await pool.query('SELECT id, full_name, email FROM users WHERE id = ?', [req.session.userId]);
    if (!rows[0]) {
      return res.status(404).json({ message: 'User not found.' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load profile.' });
  }
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const summary = await getSummaryData(req.session.userId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load summary.' });
  }
});

app.get('/api/expenses', requireAuth, async (req, res) => {
  if (!dbReady) {
    return res.json({ expenses: getMemoryExpensesForUser(req.session.userId).sort((a, b) => b.expenseDate.localeCompare(a.expenseDate)) });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM expenses WHERE user_id = ? ORDER BY expense_date DESC, created_at DESC', [req.session.userId]);
    res.json({ expenses: rows.map((item) => ({ ...item, transactionType: item.transaction_type || 'debit' })) });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load expenses.' });
  }
});

app.get('/api/expenses/export', requireAuth, async (req, res) => {
  try {
    const summary = await getSummaryData(req.session.userId);
    const transactions = await getUserExpenses(req.session.userId);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses-report.pdf"');

    doc.pipe(res);
    doc.fontSize(20).text('Expense Report', { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(12).text('Finora Expense Tracker', { align: 'center' });
    doc.moveDown(1.2);

    doc.fontSize(12).text(`Total Debited: ₹${Number(summary.debitTotal || 0).toFixed(2)}`);
    doc.text(`Total Credited: ₹${Number(summary.creditTotal || 0).toFixed(2)}`);
    doc.text(`Remaining Balance: ₹${(Number(summary.creditTotal || 0) - Number(summary.debitTotal || 0)).toFixed(2)}`);
    doc.moveDown(1);

    const headers = ['Title', 'Category', 'Amount', 'Type'];
    const rows = transactions.length
      ? transactions.map((item) => {
          const transactionType = item.transactionType || item.transaction_type || 'debit';
          return [
            item.title || 'Untitled',
            item.category || 'Other',
            `₹${Number(item.amount || 0).toFixed(2)}`,
            transactionType === 'credit' ? 'Credit' : 'Debit'
          ];
        })
      : [['No transactions yet', '', '₹0.00', '']];

    const tableTop = 180;
    const colWidths = [140, 110, 90, 70];
    const startX = 36;
    let y = tableTop;

    doc.font('Helvetica-Bold');
    headers.forEach((header, index) => {
      doc.rect(startX + colWidths.slice(0, index).reduce((a, b) => a + b, 0), y, colWidths[index], 20).fillAndStroke('#f5f5f5', '#cccccc');
      doc.fillColor('#111111').text(header, startX + colWidths.slice(0, index).reduce((a, b) => a + b, 0) + 6, y + 4, { width: colWidths[index] - 6, align: 'left' });
    });

    y += 20;
    doc.font('Helvetica');
    rows.forEach((row) => {
      row.forEach((cell, index) => {
        const x = startX + colWidths.slice(0, index).reduce((a, b) => a + b, 0);
        doc.rect(x, y, colWidths[index], 18).stroke('#dddddd');
        doc.fillColor('#222222').text(String(cell), x + 4, y + 3, { width: colWidths[index] - 6, align: 'left' });
      });
      y += 18;
    });

    doc.end();
  } catch (err) {
    res.status(500).json({ message: 'Failed to export expenses.' });
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  if (!dbReady) {
    const { title, amount, category, description, expenseDate, transactionType } = req.body;
    if (!title || !amount || !expenseDate) {
      return res.status(400).json({ message: 'Please provide title, amount, and date.' });
    }
    if (!category) {
      return res.status(400).json({ message: 'Please choose a category.' });
    }

    memoryExpenses.push({
      id: memoryExpenseId++,
      userId: Number(req.session.userId),
      title,
      amount: Number(amount),
      category,
      description: description || '',
      expenseDate,
      transactionType: transactionType === 'credit' ? 'credit' : 'debit'
    });
    saveDataStore();
    return res.status(201).json({ message: 'Expense added.' });
  }
  try {
    const { title, amount, category, description, expenseDate, transactionType } = req.body;
    if (!title || !amount || !expenseDate) {
      return res.status(400).json({ message: 'Please provide title, amount, and date.' });
    }
    if (!category) {
      return res.status(400).json({ message: 'Please choose a category.' });
    }

    await pool.query(
      'INSERT INTO expenses (user_id, title, amount, category, description, expense_date, transaction_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.session.userId, title, amount, category, description || '', expenseDate, transactionType === 'credit' ? 'credit' : 'debit']
    );

    res.status(201).json({ message: 'Expense added.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save expense.' });
  }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
  if (!dbReady) {
    const index = memoryExpenses.findIndex((expense) => expense.id === Number(req.params.id) && expense.userId === Number(req.session.userId));
    if (index !== -1) {
      memoryExpenses.splice(index, 1);
      saveDataStore();
    }
    return res.json({ message: 'Expense removed.' });
  }
  try {
    await pool.query('DELETE FROM expenses WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
    res.json({ message: 'Expense removed.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete expense.' });
  }
});

(async () => {
  loadDataStore();
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})();
