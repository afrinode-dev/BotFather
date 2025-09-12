// server.js
const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// Configuration
const MANAGER_TOKEN = process.env.MANAGER_TOKEN;
const PORT = process.env.PORT || 3000;
const INSTANCES_DIR = path.join(__dirname, 'instances');
const LOGS_DIR = path.join(__dirname, 'logs');
const REPO_URL = 'https://github.com/Danscot/senku-xmd';

// Vérification du token
if (!MANAGER_TOKEN) {
  console.error('❌ MANAGER_TOKEN est requis dans les variables d\'environnement');
  process.exit(1);
}

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
    pid INTEGER,
    username TEXT,
    first_name TEXT,
    log_file TEXT
  )`);
});

// Initialisation du bot manager
const bot = new Telegraf(MANAGER_TOKEN);

// Middleware de session
bot.use(session());

// Serveur web pour Render
const app = express();
app.get('/', (req, res) => {
  res.send('🤖 BotFather est en ligne!');
});
app.listen(PORT, () => {
  console.log(`🚀 Serveur web démarré sur le port ${PORT}`);
});

// Fonction utilitaire pour valider un token
async function validateToken(token) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, {
      timeout: 10000
    });
    return response.data.ok ? response.data.result : false;
  } catch (error) {
    console.error('Erreur validation token:', error.message);
    return false;
  }
}

// Fonction pour exécuter une commande avec timeout et journalisation
function executeCommand(command, args, options, logFile, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    
    let timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout après ${timeout/1000} secondes`));
    }, timeout);
    
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Processus terminé avec le code ${code}`));
      }
    });
    
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

// Fonction pour créer un nouveau bot (version non bloquante)
async function createNewBot(token, ctx) {
  const message = await ctx.reply('🔄 Début du déploiement...');
  const messageId = message.message_id;
  const chatId = ctx.chat.id;
  
  // Démarrer le déploiement en arrière-plan
  deployBotInBackground(token, chatId, messageId);
  
  return { success: true, message: 'Déploiement démarré en arrière-plan. Vous serez notifié à la fin.' };
}

// Fonction pour déployer un bot en arrière-plan
async function deployBotInBackground(token, chatId, messageId) {
  let botName = '';
  let botFolder = '';
  let logFile = '';
  
  try {
    // Mettre à jour le message de statut
    await bot.telegram.editMessageText(chatId, messageId, null, '🔍 Validation du token...');
    
    // Valider le token
    const botInfo = await validateToken(token);
    if (!botInfo) {
      throw new Error('Token invalide');
    }
    
    // Vérifier si le token existe déjà
    const existingBot = await new Promise((resolve) => {
      db.get('SELECT * FROM bots WHERE token = ?', [token], (err, row) => {
        resolve(row);
      });
    });

    if (existingBot) {
      throw new Error('Ce token est déjà utilisé');
    }
    
    // Créer le dossier d'instance
    botName = `senku-${Date.now()}`;
    botFolder = path.join(INSTANCES_DIR, botName);
    await fs.ensureDir(botFolder);
    
    // Créer le fichier de log
    logFile = path.join(LOGS_DIR, `${botName}.log`);
    await fs.ensureDir(path.dirname(logFile));
    
    await bot.telegram.editMessageText(chatId, messageId, null, '📥 Clonage du repository...');
    
    // Cloner le repo avec timeout
    await executeCommand('git', ['clone', '--depth', '1', REPO_URL, botFolder], {}, logFile, 180000);
    
    await bot.telegram.editMessageText(chatId, messageId, null, '⚙️ Configuration de l\'environnement...');
    
    // Créer le fichier .env
    const envContent = `BOT_TOKEN=${token}\nNODE_ENV=production\n`;
    await fs.writeFile(path.join(botFolder, '.env'), envContent);
    
    await bot.telegram.editMessageText(chatId, messageId, null, '📦 Installation des dépendances...');
    
    // Installer les dépendances avec timeout
    await executeCommand('npm', ['install', '--production'], { cwd: botFolder }, logFile, 240000);
    
    await bot.telegram.editMessageText(chatId, messageId, null, '🚀 Démarrage de l\'instance...');
    
    // Démarrer le bot
    const child = spawn('npm', ['start'], {
      cwd: botFolder,
      env: { ...process.env, BOT_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    
    // Rediriger les logs vers un fichier
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    
    // Attendre un peu pour que le bot démarre
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Vérifier que le bot fonctionne
    const isRunning = await validateToken(token);
    if (!isRunning) {
      throw new Error('Le bot ne répond pas après le démarrage');
    }
    
    // Enregistrer le bot dans la base de données
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO bots (name, token, folder, status, pid, username, first_name, log_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [botName, token, botFolder, 'running', child.pid, botInfo.username, botInfo.first_name, logFile],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    // Message de succès
    await bot.telegram.editMessageText(
      chatId, 
      messageId, 
      null,
      `✅ Bot ${botInfo.first_name} (@${botInfo.username}) déployé avec succès!\n\n📁 Dossier: ${botName}\n🆔 ID: ${this.lastID}`
    );
    
  } catch (error) {
    console.error('Erreur lors du déploiement:', error);
    
    // Nettoyer les fichiers en cas d'erreur
    if (botFolder && await fs.pathExists(botFolder)) {
      await fs.remove(botFolder).catch(() => {});
    }
    
    // Message d'erreur
    try {
      await bot.telegram.editMessageText(
        chatId, 
        messageId, 
        null,
        `❌ Erreur lors du déploiement: ${error.message}\n\nConsultez les logs pour plus de détails.`
      );
    } catch (editError) {
      // Si le message a été supprimé ou autre erreur, envoyer un nouveau message
      await bot.telegram.sendMessage(
        chatId,
        `❌ Erreur lors du déploiement: ${error.message}\n\nConsultez les logs pour plus de détails.`
      );
    }
  }
}

// Fonction pour arrêter un bot
async function stopBot(botId, ctx) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM bots WHERE id = ?', [botId], async (err, row) => {
      if (err || !row) {
        resolve({ success: false, message: '❌ Bot non trouvé' });
        return;
      }

      try {
        // Arrêter le processus
        if (row.pid) {
          try {
            process.kill(row.pid);
          } catch (killError) {
            console.log('Processus déjà terminé ou inaccessible');
          }
        }

        // Mettre à jour le statut en base
        db.run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['stopped', botId]);
        
        resolve({ success: true, message: `✅ Bot ${row.name} arrêté avec succès` });
      } catch (error) {
        resolve({ success: false, message: '❌ Erreur: ' + error.message });
      }
    });
  });
}

// Fonction pour redémarrer un bot
async function restartBot(botId, ctx) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM bots WHERE id = ?', [botId], async (err, row) => {
      if (err || !row) {
        resolve({ success: false, message: '❌ Bot non trouvé' });
        return;
      }

      try {
        // Arrêter d'abord le bot
        if (row.pid) {
          try {
            process.kill(row.pid);
          } catch (killError) {
            console.log('Processus déjà terminé');
          }
        }

        // Redémarrer le bot
        const child = spawn('npm', ['start'], {
          cwd: row.folder,
          env: { ...process.env, BOT_TOKEN: row.token },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });

        // Rediriger les logs
        const logStream = fs.createWriteStream(row.log_file, { flags: 'a' });
        child.stdout.pipe(logStream);
        child.stderr.pipe(logStream);

        // Mettre à jour la base de données
        db.run('UPDATE bots SET status = ?, pid = ? WHERE id = ?', ['running', child.pid, botId]);

        resolve({ success: true, message: `✅ Bot ${row.name} redémarré avec succès` });
      } catch (error) {
        resolve({ success: false, message: '❌ Erreur: ' + error.message });
      }
    });
  });
}

// Fonction pour lister les bots
async function listBots(ctx) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM bots ORDER BY created_at DESC', (err, rows) => {
      if (err) {
        resolve({ success: false, message: '❌ Erreur base de données: ' + err.message });
        return;
      }

      if (rows.length === 0) {
        resolve({ success: true, message: '📭 Aucun bot déployé pour le moment.', bots: [] });
        return;
      }

      let message = '📋 Vos bots déployés:\n\n';
      rows.forEach((bot, index) => {
        const tokenPreview = bot.token.substring(0, 10) + '...' + bot.token.substring(bot.token.length - 5);
        message += `🤖 ${bot.first_name || bot.name} (@${bot.username || 'sans username'})\n`;
        message += `   📁 Dossier: ${bot.name}\n`;
        message += `   🔑 Token: ${tokenPreview}\n`;
        message += `   📊 Statut: ${bot.status === 'running' ? '🟢 En ligne' : '🔴 Arrêté'}\n`;
        message += `   🆔 ID: ${bot.id}\n\n`;
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
        resolve({ success: false, message: '❌ Bot non trouvé' });
        return;
      }

      try {
        // Vérifier si le bot répond
        const botInfo = await validateToken(row.token);
        const status = botInfo ? '🟢 En ligne et répond' : '🔴 Arrêté ou ne répond pas';
        
        resolve({ 
          success: true, 
          message: `📊 Statut de ${row.first_name || row.name}:\n${status}\n📍 Dernière vérification: ${new Date().toLocaleString()}\n📁 Dossier: ${row.name}\n🆔 ID: ${row.id}` 
        });
      } catch (error) {
        resolve({ success: false, message: '❌ Erreur: ' + error.message });
      }
    });
  });
}

// Fonction pour éditer un message avec gestion des erreurs
async function safeEditMessage(ctx, text, keyboard = null) {
  try {
    if (ctx.updateType === 'callback_query') {
      // Vérifier si le message a une photo
      if (ctx.callbackQuery.message.photo) {
        // Supprimer le message avec photo et en créer un nouveau avec du texte
        await ctx.deleteMessage();
        return await ctx.reply(text, keyboard ? Markup.inlineKeyboard(keyboard) : undefined);
      } else {
        // Modifier le message texte normal
        return await ctx.editMessageText(text, keyboard ? Markup.inlineKeyboard(keyboard) : undefined);
      }
    }
  } catch (error) {
    console.error('Erreur lors de l\'édition du message:', error.message);
    // En cas d'erreur, envoyer un nouveau message
    return await ctx.reply(text, keyboard ? Markup.inlineKeyboard(keyboard) : undefined);
  }
}

// Commandes du bot
bot.command('start', async (ctx) => {
  const welcomeText = `🤖 *BotFather* 🤖\n\n` +
    `Je peux vous aider à déployer et gérer vos instances automatiquement.\n\n` +
    `*Commandes disponibles:*\n` +
    `/newbot <token> - Déployer une nouvelle instance\n` +
    `/mybots - Lister vos bots déployés\n` +
    `/stopbot <id> - Arrêter un bot\n` +
    `/restartbot <id> - Redémarrer un bot\n` +
    `/status <id> - Vérifier le statut d'un bot\n` +
    `/menu - Afficher le menu interactif`;
  
  try {
    await ctx.replyWithPhoto(
      { url: 'https://raw.githubusercontent.com/afrinode-dev/BotFather/refs/heads/main/bot.png' },
      { 
        caption: welcomeText, 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Déployer un bot', callback_data: 'deploy_bot' }],
            [{ text: '📋 Voir mes bots', callback_data: 'list_bots' }]
          ]
        }
      }
    );
  } catch (error) {
    // Fallback si l'image ne charge pas
    await ctx.reply(welcomeText, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Déployer un bot', callback_data: 'deploy_bot' }],
          [{ text: '📋 Voir mes bots', callback_data: 'list_bots' }]
        ]
      }
    });
  }
});

bot.command('newbot', async (ctx) => {
  const token = ctx.message.text.split(' ')[1];
  
  if (!token) {
    return ctx.reply('❌ Usage: /newbot <token>\n\nExemple: /newbot 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  }
  
  const result = await createNewBot(token, ctx);
  if (result.message) {
    ctx.reply(result.message);
  }
});

bot.command('mybots', async (ctx) => {
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    // Créer des boutons pour chaque bot
    const buttons = result.bots.map(bot => [
      Markup.button.callback(`${bot.first_name || bot.name}`, `bot_detail_${bot.id}`)
    ]);
    
    // Ajouter un bouton de retour au menu
    buttons.push([Markup.button.callback('🔙 Retour au menu', 'main_menu')]);
    
    await ctx.reply(result.message, Markup.inlineKeyboard(buttons));
  } else {
    await ctx.reply(result.message, Markup.inlineKeyboard([
      [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
      [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
    ]));
  }
});

bot.command('stopbot', async (ctx) => {
  const botId = ctx.message.text.split(' ')[1];
  
  if (!botId || isNaN(botId)) {
    return ctx.reply('❌ Usage: /stopbot <id>\n\nUtilisez /mybots pour obtenir les IDs de vos bots.');
  }
  
  const result = await stopBot(botId, ctx);
  ctx.reply(result.message);
});

bot.command('restartbot', async (ctx) => {
  const botId = ctx.message.text.split(' ')[1];
  
  if (!botId || isNaN(botId)) {
    return ctx.reply('❌ Usage: /restartbot <id>\n\nUtilisez /mybots pour obtenir les IDs de vos bots.');
  }
  
  const result = await restartBot(botId, ctx);
  ctx.reply(result.message);
});

bot.command('status', async (ctx) => {
  const botId = ctx.message.text.split(' ')[1];
  
  if (!botId || isNaN(botId)) {
    return ctx.reply('❌ Usage: /status <id>\n\nUtilisez /mybots pour obtenir les IDs de vos bots.');
  }
  
  const result = await getBotStatus(botId, ctx);
  ctx.reply(result.message);
});

bot.command('menu', async (ctx) => {
  const menuText = '🎮 Menu de gestion des bots Senku';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
    [Markup.button.callback('📋 Voir mes bots', 'list_bots')],
    [Markup.button.callback('🔄 Redémarrer un bot', 'restart_bot_menu')],
    [Markup.button.callback('🛑 Arrêter un bot', 'stop_bot_menu')]
  ]);
  
  try {
    await ctx.replyWithPhoto(
      { url: 'https://raw.githubusercontent.com/afrinode-dev/BotFather/refs/heads/main/bot.png' },
      { caption: menuText, reply_markup: keyboard.reply_markup }
    );
  } catch (error) {
    // Fallback si l'image ne charge pas
    await ctx.reply(menuText, { reply_markup: keyboard.reply_markup });
  }
});

// Gestion des actions de boutons
bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  
  const menuText = '🤖 *BotFather* 🤖\n\nQue souhaitez-vous faire?';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
    [Markup.button.callback('📋 Voir mes bots', 'list_bots')],
    [Markup.button.callback('🔄 Redémarrer un bot', 'restart_bot_menu')],
    [Markup.button.callback('🛑 Arrêter un bot', 'stop_bot_menu')]
  ]);
  
  await ctx.reply(menuText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup 
  });
});

bot.action('deploy_bot', async (ctx) => {
  await ctx.answerCbQuery();
  
  const messageText = 'Pour déployer un nouveau bot, envoyez la commande /newbot suivie de votre token.\n\nExemple:\n<code>/newbot 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ</code>\n\nAssurez-vous que le token est valide et que le bot a été créé via @BotFather.';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
  ]);
  
  await safeEditMessage(ctx, messageText, keyboard);
});

bot.action('list_bots', async (ctx) => {
  await ctx.answerCbQuery();
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    const buttons = result.bots.map(bot => 
      [Markup.button.callback(`${bot.first_name || bot.name}`, `bot_detail_${bot.id}`)]
    );
    
    buttons.push([Markup.button.callback('🔙 Retour au menu', 'main_menu')]);
    
    await safeEditMessage(ctx, result.message, buttons);
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
      [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
    ]);
    
    await safeEditMessage(ctx, result.message, keyboard);
  }
});

bot.action('restart_bot_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    const buttons = result.bots.map(bot => 
      [Markup.button.callback(`${bot.first_name || bot.name}`, `restart_${bot.id}`)]
    );
    
    buttons.push([Markup.button.callback('🔙 Retour au menu', 'main_menu')]);
    
    await safeEditMessage(ctx, '🔄 Sélectionnez le bot à redémarrer:', buttons);
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
      [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
    ]);
    
    await safeEditMessage(ctx, '📭 Aucun bot à redémarrer.', keyboard);
  }
});

bot.action('stop_bot_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    const buttons = result.bots.map(bot => 
      [Markup.button.callback(`${bot.first_name || bot.name}`, `stop_${bot.id}`)]
    );
    
    buttons.push([Markup.button.callback('🔙 Retour au menu', 'main_menu')]);
    
    await safeEditMessage(ctx, '🛑 Sélectionnez le bot à arrêter:', buttons);
  } else {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
      [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
    ]);
    
    await safeEditMessage(ctx, '📭 Aucun bot à arrêter.', keyboard);
  }
});

bot.action(/bot_detail_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = ctx.match[1];
  const result = await getBotStatus(botId, ctx);
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Redémarrer', `restart_${botId}`)],
    [Markup.button.callback('🛑 Arrêter', `stop_${botId}`)],
    [Markup.button.callback('🔙 Retour à la liste', 'list_bots')]
  ]);
  
  await safeEditMessage(ctx, result.message, keyboard);
});

bot.action(/restart_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = ctx.match[1];
  const result = await restartBot(botId, ctx);
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Voir le statut', `bot_detail_${botId}`)],
    [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
  ]);
  
  await safeEditMessage(ctx, result.message, keyboard);
});

bot.action(/stop_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const botId = ctx.match[1];
  const result = await stopBot(botId, ctx);
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Redémarrer', `restart_${botId}`)],
    [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
  ]);
  
  await safeEditMessage(ctx, result.message, keyboard);
});

// Gestion des erreurs
bot.catch((err, ctx) => {
  console.error(`❌ Erreur pour ${ctx.updateType}:`, err);
  try {
    ctx.reply('❌ Une erreur s\'est produite. Veuillez réessayer.').catch(() => {});
  } catch (e) {
    // Ignorer les erreurs de réponse
  }
});

// Démarrer le bot manager
bot.launch().then(() => {
  console.log('🤖 BotFather démarré avec succès!');
}).catch(err => {
  console.error('❌ Erreur au démarrage du bot:', err);
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

// Nettoyer les processus orphelins au démarrage
db.all('SELECT * FROM bots WHERE status = "running"', (err, rows) => {
  if (err) return;
  
  rows.forEach(row => {
    db.run('UPDATE bots SET status = "stopped", pid = NULL WHERE id = ?', [row.id]);
  });
});
