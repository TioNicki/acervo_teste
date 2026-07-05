const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const fallbackDataPath = path.join(__dirname, 'data', 'livros.json');
const fallbackUsersPath = path.join(__dirname, 'data', 'usuarios.json');

function normalizeConnectionString(connectionString) {
  const lastAt = connectionString.lastIndexOf('@');
  if (lastAt <= 0) return connectionString;

  const prefix = connectionString.slice(0, lastAt);
  const suffix = connectionString.slice(lastAt + 1);

  const schemeSeparator = '://';
  const schemeIndex = prefix.indexOf(schemeSeparator);
  if (schemeIndex < 0) return connectionString;

  const scheme = prefix.slice(0, schemeIndex + schemeSeparator.length);
  const authPart = prefix.slice(schemeIndex + schemeSeparator.length);
  const encodedAuth = authPart.replace(/@/g, '%40');
  return `${scheme}${encodedAuth}@${suffix}`;
}

function ensureStore(filePath, fallbackContent) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, fallbackContent, 'utf8');
  }
}

function readJsonFile(filePath, fallbackValue) {
  ensureStore(filePath, JSON.stringify(fallbackValue));
  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawData);
    return parsed;
  } catch (error) {
    console.warn(`Não foi possível ler ${filePath}, iniciando vazio.`, error.message);
    return fallbackValue;
  }
}

function writeJsonFile(filePath, data) {
  ensureStore(filePath, JSON.stringify(data));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeBook(book, fallbackId = null, userId = null) {
  return {
    id: book.id ?? fallbackId ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    titulo: book.titulo ?? '',
    autor: book.autor ?? '',
    descricao: book.descricao ?? '',
    paginas: Number(book.paginas) || 0,
    paginas_lidas: Number(book.paginas_lidas) || 0,
    capa: book.capa ?? '',
    id_usuario: book.id_usuario ?? userId ?? null,
    created_at: book.created_at ?? new Date().toISOString(),
  };
}

function normalizeUser(user, fallbackId = null) {
  return {
    id: user.id ?? fallbackId ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    usuario: user.usuario ?? '',
    senha: user.senha ?? '',
  };
}

let fallbackBooks = readJsonFile(fallbackDataPath, []);
let fallbackUsers = readJsonFile(fallbackUsersPath, []);
let pool = null;
let databaseInitPromise = null;

function getDatabaseConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || null;
}

async function initializeDatabase() {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    console.warn('DATABASE_URL não configurada; usando armazenamento local para usuários e livros.');
    return false;
  }

  if (pool) {
    return true;
  }

  pool = new Pool({
    connectionString: normalizeConnectionString(connectionString),
    ssl: process.env.NODE_ENV === 'production' || connectionString.includes('render.com')
      ? { rejectUnauthorized: false }
      : false,
  });

  try {
    await ensureDatabaseSchema();
    await pool.query('SELECT 1');
    console.log('Conexão com banco estabelecida.');
    return true;
  } catch (error) {
    console.warn('Falha ao conectar ao banco, usando armazenamento local:', error.message);
    pool = null;
    return false;
  }
}

async function ensureDatabaseReady() {
  if (!databaseInitPromise) {
    databaseInitPromise = initializeDatabase();
  }

  return databaseInitPromise;
}

async function isDatabaseAvailable() {
  const databaseReady = await ensureDatabaseReady();
  if (!databaseReady || !pool) return false;

  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    console.warn('Banco não disponível, usando armazenamento local:', error.message);
    return false;
  }
}

async function ensureDatabaseSchema() {
  if (!pool) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios_acervo (
        id SERIAL PRIMARY KEY,
        usuario TEXT NOT NULL UNIQUE,
        senha TEXT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS acervo_literario (
        id SERIAL PRIMARY KEY,
        titulo TEXT,
        autor TEXT,
        descricao TEXT,
        paginas INTEGER DEFAULT 0,
        paginas_lidas INTEGER DEFAULT 0,
        capa TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        id_usuario INTEGER
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_acervo_literario_id_usuario
      ON acervo_literario (id_usuario)
    `);
  } catch (error) {
    console.warn('Não foi possível preparar o esquema do banco:', error.message);
  }
}

function getUserIdFromRequest(req) {
  return req.headers['x-user-id'] || req.body?.id_usuario || req.query?.id_usuario || null;
}

async function findUserByCredentials(usuario, senha) {
  if (pool && (await isDatabaseAvailable())) {
    try {
      const result = await pool.query(
        'SELECT id, usuario, senha FROM usuarios_acervo WHERE usuario = $1 AND senha = $2',
        [usuario, senha]
      );
      return result.rows[0] ? normalizeUser(result.rows[0]) : null;
    } catch (error) {
      console.warn('Falha ao consultar usuário no banco, usando fallback local.', error.message);
    }
  }

  return fallbackUsers.find((user) => user.usuario === usuario && user.senha === senha) || null;
}

async function createUser(usuario, senha) {
  if (pool && (await isDatabaseAvailable())) {
    try {
      const result = await pool.query(
        'INSERT INTO usuarios_acervo (usuario, senha) VALUES ($1, $2) RETURNING id, usuario, senha',
        [usuario, senha]
      );
      return result.rows[0] ? normalizeUser(result.rows[0]) : null;
    } catch (error) {
      console.warn('Falha ao criar usuário no banco, usando fallback local.', error.message);
    }
  }

  if (fallbackUsers.some((user) => user.usuario === usuario)) {
    return null;
  }

  const newUser = normalizeUser({ usuario, senha });
  fallbackUsers = [newUser, ...fallbackUsers];
  writeJsonFile(fallbackUsersPath, fallbackUsers);
  return newUser;
}

async function getBooksFromDatabase(userId) {
  const query = `
    SELECT
      id,
      titulo,
      autor,
      descricao,
      paginas,
      paginas_lidas,
      capa,
      created_at,
      id_usuario
    FROM acervo_literario
    WHERE id_usuario = $1
    ORDER BY titulo
  `;
  const result = await pool.query(query, [userId]);
  return result.rows.map((row) => normalizeBook(row, row.id, userId));
}

async function createBookInDatabase(bookData, userId) {
  const query = `
    INSERT INTO acervo_literario (titulo, autor, descricao, paginas, paginas_lidas, capa, id_usuario)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, titulo, autor, descricao, paginas, paginas_lidas, capa, created_at, id_usuario
  `;
  const result = await pool.query(query, [
    bookData.titulo,
    bookData.autor,
    bookData.descricao,
    bookData.paginas,
    bookData.paginas_lidas,
    bookData.capa,
    userId,
  ]);
  return normalizeBook(result.rows[0], result.rows[0].id, userId);
}

async function updateBookInDatabase(bookId, bookData, userId) {
  const query = `
    UPDATE acervo_literario
    SET titulo = $2,
        autor = $3,
        descricao = $4,
        paginas = $5,
        paginas_lidas = $6,
        capa = $7
    WHERE id = $1 AND id_usuario = $8
    RETURNING id, titulo, autor, descricao, paginas, paginas_lidas, capa, created_at, id_usuario
  `;
  const result = await pool.query(query, [bookId, bookData.titulo, bookData.autor, bookData.descricao, bookData.paginas, bookData.paginas_lidas, bookData.capa, userId]);
  return result.rows[0] ? normalizeBook(result.rows[0], result.rows[0].id, userId) : null;
}

async function deleteBookInDatabase(bookId, userId) {
  const result = await pool.query('DELETE FROM acervo_literario WHERE id = $1 AND id_usuario = $2', [bookId, userId]);
  return result.rowCount > 0;
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index', (req, res) => {
  res.redirect('/');
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.use(express.static(path.join(__dirname)));

app.get('/api/health', async (req, res) => {
  const databaseReady = await ensureDatabaseReady();
  res.json({
    status: 'ok',
    mode: databaseReady ? 'database-or-fallback' : 'fallback',
    databaseConfigured: Boolean(getDatabaseConnectionString()),
  });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    if (!usuario || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const user = await findUserByCredentials(usuario, senha);
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    return res.json(user);
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    if (!usuario || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const user = await createUser(usuario, senha);
    if (!user) {
      return res.status(409).json({ error: 'Nome de usuário já existe.' });
    }

    return res.status(201).json(user);
  } catch (error) {
    console.error('Erro no cadastro:', error);
    return res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    return res.json({
      success: true,
      message: 'Logout realizado com sucesso.',
      userId: userId || null,
    });
  } catch (error) {
    console.error('Erro no logout:', error);
    return res.status(500).json({ error: 'Erro ao realizar logout.' });
  }
});

app.get('/api/livros', async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    if (pool && (await isDatabaseAvailable())) {
      const books = await getBooksFromDatabase(userId);
      return res.json(books);
    }

    const books = fallbackBooks.filter((book) => String(book.id_usuario) === String(userId));
    return res.json(books.map((book) => normalizeBook(book, book.id, userId)));
  } catch (error) {
    console.error('Erro ao buscar livros:', error);
    return res.status(500).json({ error: 'Erro ao buscar livros.' });
  }
});

app.post('/api/livros', async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { titulo, autor, descricao = '', paginas = 0, paginas_lidas = 0, capa = '' } = req.body;

    if (pool && (await isDatabaseAvailable())) {
      const newBook = await createBookInDatabase({ titulo, autor, descricao, paginas, paginas_lidas, capa }, userId);
      return res.status(201).json(newBook);
    }

    const newBook = normalizeBook({
      titulo,
      autor,
      descricao,
      paginas,
      paginas_lidas,
      capa,
      id_usuario: userId,
      created_at: new Date().toISOString(),
    }, null, userId);
    fallbackBooks = [newBook, ...fallbackBooks];
    writeJsonFile(fallbackDataPath, fallbackBooks);
    return res.status(201).json(newBook);
  } catch (error) {
    console.error('Erro ao criar livro:', error);
    return res.status(500).json({ error: 'Erro ao criar livro' });
  }
});

app.put('/api/livros/:id', async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { id } = req.params;
    const { titulo, autor, descricao = '', paginas = 0, paginas_lidas = 0, capa = '' } = req.body;

    if (pool && (await isDatabaseAvailable())) {
      const updatedBook = await updateBookInDatabase(id, { titulo, autor, descricao, paginas, paginas_lidas, capa }, userId);
      if (!updatedBook) {
        return res.status(404).json({ error: 'Livro não encontrado' });
      }
      return res.json(updatedBook);
    }

    const existingBook = fallbackBooks.find((book) => String(book.id) === String(id) && String(book.id_usuario) === String(userId));
    if (!existingBook) {
      return res.status(404).json({ error: 'Livro não encontrado' });
    }

    const updatedBook = normalizeBook({
      ...existingBook,
      titulo,
      autor,
      descricao,
      paginas,
      paginas_lidas,
      capa,
      id_usuario: userId,
      created_at: existingBook.created_at || new Date().toISOString(),
    }, id, userId);
    fallbackBooks = fallbackBooks.map((book) => String(book.id) === String(id) ? updatedBook : book);
    writeJsonFile(fallbackDataPath, fallbackBooks);
    return res.json(updatedBook);
  } catch (error) {
    console.error('Erro ao atualizar livro:', error);
    return res.status(500).json({ error: 'Erro ao atualizar livro' });
  }
});

app.delete('/api/livros/:id', async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { id } = req.params;

    if (pool && (await isDatabaseAvailable())) {
      const deleted = await deleteBookInDatabase(id, userId);
      if (!deleted) {
        return res.status(404).json({ error: 'Livro não encontrado' });
      }
      return res.json({ success: true });
    }

    const existed = fallbackBooks.some((book) => String(book.id) === String(id) && String(book.id_usuario) === String(userId));
    if (!existed) {
      return res.status(404).json({ error: 'Livro não encontrado' });
    }

    fallbackBooks = fallbackBooks.filter((book) => String(book.id) !== String(id));
    writeJsonFile(fallbackDataPath, fallbackBooks);
    return res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover livro:', error);
    return res.status(500).json({ error: 'Erro ao remover livro' });
  }
});

app.use((err, req, res, next) => {
  console.error('Middleware de erro:', err);
  res.status(500).json({ error: 'Erro interno no servidor' });
});

app.listen(port, () => {
  console.log(`Backend iniciado em http://localhost:${port}`);
  console.log(`Armazenamento local ativo em ${fallbackDataPath}`);
});