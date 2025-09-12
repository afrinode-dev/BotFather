// server.js - BotFather Custom
const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Configuration
const MANAGER_TOKEN = process.env.MANAGER_TOKEN || 'VOTRE_TOKEN_MANAGER';
const INSTANCES_DIR = path.join(__dirname, 'instances');
const LOGS_DIR = path.join(__dirname, 'logs');
const REPO_URL = 'https://github.com/Danscot/senku-xmd';

// Initialisation de la base de données
const db = new sqlite3.Database(path.join(__dirname, 'bots.db'));

// Initialisation de la base de données
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL,
    status TEXT DEFAULT 'stopped',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pid INTEGER
  )`);
});

// Initialisation du bot manager
const bot = new Telegraf(MANAGER_TOKEN);

// Middleware de session
bot.use(session());

// Fonction utilitaire pour valider un token
async function validateToken(token) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    return response.data.ok ? response.data.result : false;
  } catch (error) {
    return false;
  }
}

// Fonction pour créer un nouveau bot
async function createNewBot(token, ctx) {
  try {
    // Valider le token
    const botInfo = await validateToken(token);
    if (!botInfo) {
      return { success: false, message: 'Token invalide. Veuillez vérifier et réessayer.' };
    }

    // Créer le dossier d'instance
    const botName = `senku-${Date.now()}`;
    const botFolder = path.join(INSTANCES_DIR, botName);
    await fs.ensureDir(botFolder);

    // Cloner le repo
    await new Promise((resolve, reject) => {
      exec(`git clone ${REPO_URL} ${botFolder}`, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Créer le fichier .env
    const envContent = `BOT_TOKEN=${token}\n`;
    await fs.writeFile(path.join(botFolder, '.env'), envContent);

    // Installer les dépendances
    await new Promise((resolve, reject) => {
      exec('npm install', { cwd: botFolder }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Démarrer le bot
    const logFile = path.join(LOGS_DIR, `${botName}.log`);
    await fs.ensureDir(path.dirname(logFile));
    
    const child = spawn('npm', ['start'], {
      cwd: botFolder,
      env: { ...process.env, BOT_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Rediriger les logs vers un fichier
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    // Enregistrer le bot dans la base de données
    return new Promise((resolve) => {
      db.run(
        'INSERT INTO bots (name, token, folder, status, pid) VALUES (?, ?, ?, ?, ?)',
        [botName, token, botFolder, 'running', child.pid],
        function(err) {
          if (err) {
            resolve({ success: false, message: 'Erreur base de données: ' + err.message });
          } else {
            resolve({ 
              success: true, 
              message: `Bot ${botInfo.first_name} (@${botInfo.username}) déployé avec succès!`,
              botId: this.lastID
            });
          }
        }
      );
    });
  } catch (error) {
    return { success: false, message: 'Erreur: ' + error.message };
  }
}

// Fonction pour arrêter un bot
async function stopBot(botId, ctx) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM bots WHERE id = ?', [botId], async (err, row) => {
      if (err || !row) {
        resolve({ success: false, message: 'Bot non trouvé' });
        return;
      }

      try {
        // Arrêter le processus
        if (row.pid) {
          process.kill(row.pid);
        }

        // Mettre à jour le statut en base
        db.run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['stopped', botId]);
        
        resolve({ success: true, message: `Bot ${row.name} arrêté avec succès` });
      } catch (error) {
        resolve({ success: false, message: 'Erreur: ' + error.message });
      }
    });
  });
}

// Fonction pour lister les bots
async function listBots(ctx) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM bots ORDER BY created_at DESC', (err, rows) => {
      if (err) {
        resolve({ success: false, message: 'Erreur base de données: ' + err.message });
        return;
      }

      if (rows.length === 0) {
        resolve({ success: true, message: 'Aucun bot déployé pour le moment.', bots: [] });
        return;
      }

      let message = '📋 Vos bots déployés:\n\n';
      rows.forEach((bot, index) => {
        const tokenPreview = bot.token.substring(0, 10) + '...' + bot.token.substring(bot.token.length - 5);
        message += `${index + 1}. ${bot.name}\n`;
        message += `   Token: ${tokenPreview}\n`;
        message += `   Statut: ${bot.status === 'running' ? '🟢 En ligne' : '🔴 Arrêté'}\n`;
        message += `   ID: ${bot.id}\n\n`;
      });

      resolve({ success: true, message, bots: rows });
    });
  });
}

// Fonction pour obtenir le statut d'un bot
async function getBotStatus(botId, ctx) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM bots WHERE id = ?', [botId], async (err, row) => {
      if (err || !row) {
        resolve({ success: false, message: 'Bot non trouvé' });
        return;
      }

      try {
        // Vérifier si le bot répond
        const botInfo = await validateToken(row.token);
        const status = botInfo ? '🟢 En ligne et répond' : '🔴 Arrêté ou ne répond pas';
        
        resolve({ 
          success: true, 
          message: `Statut de ${row.name}:\n${status}\nDernière vérification: ${new Date().toLocaleString()}` 
        });
      } catch (error) {
        resolve({ success: false, message: 'Erreur: ' + error.message });
      }
    });
  });
}

// Commandes du bot
bot.command('start', async (ctx) => {
  const welcomeText = `🤖 *BotFather Custom pour Senku* 🤖\n\n` +
    `Je peux vous aider à déployer et gérer vos instances de Senku.\n\n` +
    `Commandes disponibles:\n` +
    `/newbot <token> - Déployer une nouvelle instance\n` +
    `/mybots - Lister vos bots déployés\n` +
    `/stopbot <id> - Arrêter un bot\n` +
    `/status <id> - Vérifier le statut d'un bot\n` +
    `/menu - Afficher le menu interactif`;
  
  await ctx.replyWithPhoto(
    { url: 'https://raw.githubusercontent.com/Danscot/senku-xmd/main/assets/senku-banner.jpg' },
    { caption: welcomeText, parse_mode: 'Markdown' }
  );
});

bot.command('newbot', async (ctx) => {
  const token = ctx.message.text.split(' ')[1];
  
  if (!token) {
    return ctx.reply('Usage: /newbot <token>');
  }
  
  const result = await createNewBot(token, ctx);
  ctx.reply(result.message);
});

bot.command('mybots', async (ctx) => {
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    // Ajouter des boutons pour chaque bot
    const buttons = result.bots.map(bot => 
      [Markup.button.callback(`${bot.name} (${bot.status})`, `bot_${bot.id}`)]
    );
    
    await ctx.reply(result.message, Markup.inlineKeyboard(buttons));
  } else {
    ctx.reply(result.message);
  }
});

bot.command('stopbot', async (ctx) => {
  const botId = ctx.message.text.split(' ')[1];
  
  if (!botId) {
    return ctx.reply('Usage: /stopbot <id>');
  }
  
  const result = await stopBot(botId, ctx);
  ctx.reply(result.message);
});

bot.command('status', async (ctx) => {
  const botId = ctx.message.text.split(' ')[1];
  
  if (!botId) {
    return ctx.reply('Usage: /status <id>');
  }
  
  const result = await getBotStatus(botId, ctx);
  ctx.reply(result.message);
});

bot.command('menu', (ctx) => {
  const menuText = '🎮 Menu de gestion des bots Senku';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
    [Markup.button.callback('📋 Voir mes bots', 'list_bots')],
    [Markup.button.callback('🔄 Redémarrer un bot', 'restart_bot')],
    [Markup.button.callback('🛑 Arrêter un bot', 'stop_bot')]
  ]);
  
  ctx.replyWithPhoto(
    { url: 'https://raw.githubusercontent.com/Danscot/senku-xmd/main/assets/senku-menu.jpg' },
    { caption: menuText, reply_markup: keyboard.reply_markup }
  );
});

// Gestion des actions de boutons
bot.action('deploy_bot', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Pour déployer un nouveau bot, envoyez la commande /newbot suivie de votre token.\nExemple: /newbot 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
});

bot.action('list_bots', async (ctx) => {
  await ctx.answerCbQuery();
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    const buttons = result.bots.map(bot => 
      [Markup.button.callback(`${bot.name} (${bot.status})`, `bot_${bot.id}`)]
    );
    
    await ctx.editMessageCaption(result.message, Markup.inlineKeyboard(buttons));
  } else {
    await ctx.editMessageCaption(result.message);
  }
});

bot.action(/bot_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = ctx.match[1];
  const result = await getBotStatus(botId, ctx);
  await ctx.reply(result.message);
});

// Démarrer le bot manager
bot.launch().then(() => {
  console.log('🤖 BotFather Custom démarré avec succès!');
});

// Gestion propre de l'arrêt
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  db.close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  db.close();
});
