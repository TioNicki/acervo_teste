const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

require('dotenv').config();

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

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

function normalizeBook(book, userId = null) {
  return {
    id: book.id,
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

function normalizeUser(user) {
  return {
    id: user.id,
    usuario: user.usuario ?? '',
    senha: user.senha ?? '',
  };
}

let pool = null;
let databaseInitPromise = null;
let lastDatabaseError = null;

function getErrorMessage(error) {
  if (!error) return null;
  if (error.message) return error.message;
  if (error.code) return error.code;
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map(getErrorMessage).filter(Boolean).join('; ');
  }
  return String(error);
}

function getDatabaseConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || null;
}

async function initializeDatabase() {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    console.error('DATABASE_URL não configurada. O app exige Postgres no Render.');
    lastDatabaseError = 'DATABASE_URL não configurada.';
    return false;
  }

  if (pool) return true;
  lastDatabaseError = null;

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
    lastDatabaseError = null;
    return true;
  } catch (error) {
    lastDatabaseError = getErrorMessage(error);
    console.error('Falha ao conectar ao banco. Verifique DATABASE_URL no Render ou no ambiente local:', lastDatabaseError);
    await pool.end().catch(() => {});
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

async function requireDatabase(req, res, next) {
  const databaseReady = await ensureDatabaseReady();
  if (!databaseReady || !pool) {
    return res.status(503).json({
      error: 'Banco de dados indisponível. Verifique a DATABASE_URL no Render.',
      databaseConnected: false,
      databaseError: lastDatabaseError,
    });
  }

  try {
    await pool.query('SELECT 1');
    lastDatabaseError = null;
    return next();
  } catch (error) {
    lastDatabaseError = getErrorMessage(error);
    return res.status(503).json({
      error: 'Banco de dados indisponível. Tente novamente em instantes.',
      databaseConnected: false,
      databaseError: lastDatabaseError,
    });
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
    lastDatabaseError = getErrorMessage(error);
    console.warn('Não foi possível preparar o esquema do banco:', lastDatabaseError);
    throw error;
  }
}

function getUserIdFromRequest(req) {
  return req.headers['x-user-id'] || req.body?.id_usuario || req.query?.id_usuario || null;
}

async function findUserByCredentials(usuario, senha) {
  const result = await pool.query(
    'SELECT id, usuario, senha FROM usuarios_acervo WHERE usuario = $1 AND senha = $2',
    [usuario, senha]
  );
  return result.rows[0] ? normalizeUser(result.rows[0]) : null;
}

async function createUser(usuario, senha) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext(LOWER($1)))', [usuario]);

    const existingUser = await client.query(
      'SELECT id FROM usuarios_acervo WHERE LOWER(usuario) = LOWER($1) LIMIT 1',
      [usuario]
    );
    if (existingUser.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const result = await client.query(
      'INSERT INTO usuarios_acervo (usuario, senha) VALUES ($1, $2) RETURNING id, usuario, senha',
      [usuario, senha]
    );
    await client.query('COMMIT');
    return result.rows[0] ? normalizeUser(result.rows[0]) : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return null;
    throw error;
  } finally {
    client.release();
  }
}

async function getBooksFromDatabase(userId) {
  const query = `
    SELECT id, titulo, autor, descricao, paginas, paginas_lidas, capa, created_at, id_usuario
    FROM acervo_literario
    WHERE id_usuario = $1
    ORDER BY titulo
  `;
  const result = await pool.query(query, [Number(userId) || 0]);
  return result.rows.map((row) => normalizeBook(row, userId));
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
    Number(userId) || 0,
  ]);
  return normalizeBook(result.rows[0], userId);
}

async function updateBookInDatabase(bookId, bookData, userId) {
  const query = `
    UPDATE acervo_literario
    SET titulo = $2, autor = $3, descricao = $4, paginas = $5, paginas_lidas = $6, capa = $7
    WHERE id = $1 AND id_usuario = $8
    RETURNING id, titulo, autor, descricao, paginas, paginas_lidas, capa, created_at, id_usuario
  `;
  const result = await pool.query(query, [
    Number(bookId) || 0,
    bookData.titulo,
    bookData.autor,
    bookData.descricao,
    bookData.paginas,
    bookData.paginas_lidas,
    bookData.capa,
    Number(userId) || 0
  ]);
  return result.rows[0] ? normalizeBook(result.rows[0], userId) : null;
}

async function deleteBookInDatabase(bookId, userId) {
  const result = await pool.query(
    'DELETE FROM acervo_literario WHERE id = $1 AND id_usuario = $2', 
    [Number(bookId) || 0, Number(userId) || 0]
  );
  return result.rowCount > 0;
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/index', '/index.html'], (req, res) => {
  res.redirect('/');
});

app.get(['/login', '/login.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/health', async (req, res) => {
  const databaseReady = await ensureDatabaseReady();
  res.json({
    status: 'ok',
    mode: databaseReady ? 'database' : 'database-unavailable',
    databaseConfigured: Boolean(getDatabaseConnectionString()),
    databaseConnected: Boolean(databaseReady && pool),
    databaseError: lastDatabaseError,
  });
});

app.post('/api/auth/login', requireDatabase, async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const normalizedUsuario = String(usuario || '').trim();
    if (!normalizedUsuario || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const user = await findUserByCredentials(normalizedUsuario, senha);
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    return res.json(user);
  } catch (error) {
    console.error('Erro no login:', error);
    return res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

app.post('/api/auth/register', requireDatabase, async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const normalizedUsuario = String(usuario || '').trim();
    if (!normalizedUsuario || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const user = await createUser(normalizedUsuario, senha);
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

app.get('/api/livros', requireDatabase, async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const books = await getBooksFromDatabase(userId);
    return res.json(books);
  } catch (error) {
    console.error('Erro ao buscar livros:', error);
    return res.status(500).json({ error: 'Erro ao buscar livros.' });
  }
});

app.post('/api/livros', requireDatabase, async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { titulo, autor, descricao = '', paginas = 0, paginas_lidas = 0, capa = '' } = req.body;

    const newBook = await createBookInDatabase({ titulo, autor, descricao, paginas, paginas_lidas, capa }, userId);
    return res.status(201).json(newBook);
  } catch (error) {
    console.error('Erro ao criar livro:', error);
    return res.status(500).json({ error: 'Erro ao criar livro' });
  }
});

app.put('/api/livros/:id', requireDatabase, async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { id } = req.params;
    const { titulo, autor, descricao = '', paginas = 0, paginas_lidas = 0, capa = '' } = req.body;

    const updatedBook = await updateBookInDatabase(id, { titulo, autor, descricao, paginas, paginas_lidas, capa }, userId);
    if (!updatedBook) {
      return res.status(404).json({ error: 'Livro não encontrado' });
    }
    return res.json(updatedBook);
  } catch (error) {
    console.error('Erro ao atualizar livro:', error);
    return res.status(500).json({ error: 'Erro ao atualizar livro' });
  }
});

app.delete('/api/livros/:id', requireDatabase, async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: 'Usuário não informado.' });
    }

    const { id } = req.params;

    const deleted = await deleteBookInDatabase(id, userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Livro não encontrado' });
    }
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
  console.log('Persistência configurada exclusivamente no Postgres.');
});
