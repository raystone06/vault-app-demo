const express = require('express');
const { Pool } = require('pg');
const vault = require('node-vault');

const app = express();
app.use(express.json());

// Configuration depuis les variables d'environnement
const VAULT_ADDR = process.env.VAULT_ADDR;
const VAULT_ROLE_ID = process.env.VAULT_ROLE_ID;
const VAULT_SECRET_ID = process.env.VAULT_SECRET_ID;
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 5432;
const DB_NAME = process.env.DB_NAME || 'inventory';

// Validation des variables d'environnement requises
function validateEnv() {
  const required = ['VAULT_ADDR', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);
  }
}

// Initialisation du client Vault
function createVaultClient() {
  return vault({
    api: { url: VAULT_ADDR },
  });
}

// Variables globales pour la gestion des credentials
let dbPool = null;
let currentCredentials = null;
let vaultClient = null;
let isHealthy = false;

// Fonction pour récupérer les credentials PostgreSQL depuis Vault
async function getDatabaseCredentials() {
  try {
    console.log('🔐 Authentification AppRole auprès de Vault...');
    
    // Login AppRole
    const loginResult = await vaultClient.approleLogin({
      role_id: VAULT_ROLE_ID,
      secret_id: VAULT_SECRET_ID,
    });
    
    // Mise à jour du token Vault
    vaultClient.token = loginResult.auth.client_token;
    console.log('✅ Authentification AppRole réussie');
    
    // Récupération des credentials dynamiques PostgreSQL
    console.log('📡 Récupération des credentials PostgreSQL depuis Vault...');
    const credsResult = await vaultClient.read(process.env.VAULT_DB_CREDS_PATH);
    
    const credentials = {
      username: credsResult.data.username,
      password: credsResult.data.password,
      leaseId: credsResult.lease_id,
      leaseDuration: credsResult.lease_duration,
    };
    
    console.log(`✅ Credentials récupérés pour l'utilisateur: ${credentials.username}`);
    console.log(`⏱️  Durée du lease: ${credentials.leaseDuration}s`);
    
    return credentials;
    
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des credentials:', error.message);
    throw error;
  }
}

// Fonction pour créer le pool de connexions PostgreSQL
function createDatabasePool(credentials) {
  const pool = new Pool({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: credentials.username,
    password: credentials.password,
    ssl: process.env.DB_SSL_MODE === 'require' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  
  // Gestion des erreurs de pool
  pool.on('error', (err) => {
    console.error('❌ Erreur inattendue du pool PostgreSQL:', err);
    isHealthy = false;
  });
  
  return pool;
}

// Fonction pour initialiser la table items
async function initializeDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  try {
    await dbPool.query(createTableQuery);
    console.log('✅ Table "items" initialisée avec succès');
  } catch (error) {
    console.error('❌ Erreur lors de la création de la table:', error.message);
    throw error;
  }
}

// Fonction principale d'initialisation
async function initializeApp() {
  try {
    console.log('🚀 Démarrage de l\'application...');
    
    // Validation des variables d'environnement
    validateEnv();
    console.log('✅ Variables d\'environnement validées');
    
    // Création du client Vault
    vaultClient = createVaultClient();
    console.log(`✅ Client Vault configuré: ${VAULT_ADDR}`);
    
    // Récupération des credentials dynamiques
    currentCredentials = await getDatabaseCredentials();
    
    // Création du pool de connexions
    dbPool = createDatabasePool(currentCredentials);
    console.log('✅ Pool de connexions PostgreSQL créé');
    
    // Test de connexion et initialisation
    const client = await dbPool.connect();
    try {
      const result = await client.query('SELECT NOW() as current_time');
      console.log(`✅ Connexion PostgreSQL établie: ${result.rows[0].current_time}`);
    } finally {
      client.release();
    }
    
    // Création de la table si nécessaire
    await initializeDatabase();
    
    isHealthy = true;
    console.log('🎉 Application initialisée avec succès!');
    
    // Configuration du renouvellement périodique des credentials (80% de la durée du lease)
    const renewalInterval = (currentCredentials.leaseDuration * 0.8) * 1000;
    setInterval(async () => {
      try {
        console.log('🔄 Renouvellement des credentials PostgreSQL...');
        currentCredentials = await getDatabaseCredentials();
        
        // Recréation du pool avec les nouveaux credentials
        const newPool = createDatabasePool(currentCredentials);
        
        // Test de la nouvelle connexion
        const testClient = await newPool.connect();
        testClient.release();
        
        // Remplacement de l'ancien pool
        await dbPool.end();
        dbPool = newPool;
        
        console.log('✅ Credentials renouvelés et pool mis à jour');
      } catch (error) {
        console.error('❌ Erreur lors du renouvellement des credentials:', error.message);
        isHealthy = false;
      }
    }, renewalInterval);
    
  } catch (error) {
    console.error('💥 Erreur fatale lors de l\'initialisation:', error.message);
    isHealthy = false;
    
    // En cas d'erreur Vault au démarrage, on quitte avec un code d'erreur
    // pour permettre à Docker de redémarrer le conteneur
    if (error.message.includes('Vault') || error.message.includes('ECONNREFUSED')) {
      console.error('🔴 Vault est inaccessible. Arrêt de l\'application.');
      process.exit(1);
    }
    
    throw error;
  }
}

// Middleware pour vérifier l'état de l'application
function checkReady(req, res, next) {
  if (!isHealthy || !dbPool) {
    return res.status(503).json({
      error: 'Service non disponible',
      message: 'L\'application est en cours d\'initialisation ou en erreur'
    });
  }
  next();
}

// Routes CRUD

// GET /health - Statut de santé
app.get('/health', async (req, res) => {
  const health = {
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    vault: {
      configured: !!vaultClient,
      address: VAULT_ADDR,
    },
    database: {
      connected: false,
      host: DB_HOST,
      database: DB_NAME,
    }
  };
  
  // Test de connexion DB si le pool existe
  if (dbPool) {
    try {
      const client = await dbPool.connect();
      const result = await client.query('SELECT 1 as test');
      client.release();
      
      health.database.connected = true;
      health.database.test = result.rows[0].test === 1;
    } catch (error) {
      health.database.error = error.message;
    }
  }
  
  const statusCode = isHealthy && health.database.connected ? 200 : 503;
  res.status(statusCode).json(health);
});

// GET /items - Liste tous les items
app.get('/items', checkReady, async (req, res) => {
  try {
    const result = await dbPool.query(
      'SELECT id, name, quantity, price, created_at FROM items ORDER BY created_at DESC'
    );
    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows
    });
  } catch (error) {
    console.error('Erreur GET /items:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /items - Crée un nouvel item
app.post('/items', checkReady, async (req, res) => {
  const { name, quantity, price } = req.body;
  
  // Validation
  if (!name || typeof quantity !== 'number' || typeof price !== 'number') {
    return res.status(400).json({
      success: false,
      error: 'Champs requis: name (string), quantity (number), price (number)'
    });
  }
  
  try {
    const result = await dbPool.query(
      `INSERT INTO items (name, quantity, price) 
       VALUES ($1, $2, $3) 
       RETURNING id, name, quantity, price, created_at`,
      [name, quantity, price]
    );
    
    res.status(201).json({
      success: true,
      message: 'Item créé avec succès',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur POST /items:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /items/:id - Met à jour un item
app.put('/items/:id', checkReady, async (req, res) => {
  const { id } = req.params;
  const { name, quantity, price } = req.body;
  
  if (!name && typeof quantity !== 'number' && typeof price !== 'number') {
    return res.status(400).json({
      success: false,
      error: 'Au moins un champ à mettre à jour requis: name, quantity, price'
    });
  }
  
  try {
    // Construction dynamique de la requête
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (quantity !== undefined) {
      updates.push(`quantity = $${paramCount++}`);
      values.push(quantity);
    }
    if (price !== undefined) {
      updates.push(`price = $${paramCount++}`);
      values.push(price);
    }
    
    values.push(id);
    const query = `
      UPDATE items 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount} 
      RETURNING id, name, quantity, price, created_at
    `;
    
    const result = await dbPool.query(query, values);
    
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Item non trouvé'
      });
    }
    
    res.json({
      success: true,
      message: 'Item mis à jour avec succès',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur PUT /items/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /items/:id - Supprime un item
app.delete('/items/:id', checkReady, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await dbPool.query(
      'DELETE FROM items WHERE id = $1 RETURNING id, name',
      [id]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Item non trouvé'
      });
    }
    
    res.json({
      success: true,
      message: 'Item supprimé avec succès',
      deleted: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur DELETE /items/:id:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Gestion des erreurs 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route non trouvée',
    availableRoutes: ['/health', '/items', '/items/:id']
  });
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  res.status(500).json({
    success: false,
    error: 'Erreur interne du serveur'
  });
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;

// Initialisation puis démarrage
initializeApp()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Serveur démarré sur http://0.0.0.0:${PORT}`);
      console.log('');
      console.log('📋 Routes disponibles:');
      console.log(`   GET    http://localhost:${PORT}/health`);
      console.log(`   GET    http://localhost:${PORT}/items`);
      console.log(`   POST   http://localhost:${PORT}/items`);
      console.log(`   PUT    http://localhost:${PORT}/items/:id`);
      console.log(`   DELETE http://localhost:${PORT}/items/:id`);
    });
  })
  .catch((error) => {
    console.error('💥 Impossible de démarrer l\'application:', error.message);
    process.exit(1);
  });

// Gestion gracieuse de l'arrêt
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM reçu, arrêt gracieux...');
  if (dbPool) {
    await dbPool.end();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT reçu, arrêt gracieux...');
  if (dbPool) {
    await dbPool.end();
  }
  process.exit(0);
});