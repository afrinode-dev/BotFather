// server.js - Bot Déployeur Universel Avancé
const { Telegraf, Markup, session } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

// Configuration
const MANAGER_TOKEN = process.env.MANAGER_TOKEN;
const PORT = process.env.PORT || 3000;
const INSTANCES_DIR = path.join(__dirname, 'instances');
const LOGS_DIR = path.join(__dirname, 'logs');
const TEMP_DIR = path.join(__dirname, 'temp');
const DEFAULT_TELEGRAM_REPO = 'https://github.com/Danscot/senku-xmd';
const DEFAULT_WHATSAPP_REPO = 'https://github.com/lyfe00011/levanter';

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
    token TEXT,
    folder TEXT NOT NULL,
    status TEXT DEFAULT 'stopped',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pid INTEGER,
    username TEXT,
    first_name TEXT,
    log_file TEXT,
    repo_url TEXT,
    branch TEXT DEFAULT 'main',
    start_command TEXT DEFAULT 'npm start',
    build_command TEXT,
    env_vars TEXT,
    deployment_log TEXT,
    last_deployed DATETIME,
    bot_type TEXT DEFAULT 'telegram',
    webhook_url TEXT,
    health_check_url TEXT,
    max_restarts INTEGER DEFAULT 5,
    restarts_count INTEGER DEFAULT 0,
    last_restart DATETIME
  )`);
});

// Initialisation du bot manager
const bot = new Telegraf(MANAGER_TOKEN);

// Middleware de session
bot.use(session());

// Serveur web pour Render
const app = express();
app.use(express.json());
app.get('/', (req, res) => {
  res.send('🤖 Bot Déployeur Universel Avancé est en ligne!');
});

// Endpoint pour vérifier l'état des bots
app.get('/status/:botId', async (req, res) => {
  const botId = req.params.botId;
  
  db.get('SELECT * FROM bots WHERE id = ?', [botId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Bot non trouvé' });
    }
    
    res.json({
      id: row.id,
      name: row.name,
      status: row.status,
      username: row.username,
      last_deployed: row.last_deployed,
      repo_url: row.repo_url,
      bot_type: row.bot_type
    });
  });
});

// Endpoint pour les webhooks (si nécessaire)
app.post('/webhook/:botId', express.json(), (req, res) => {
  const botId = req.params.botId;
  // Traiter le webhook selon le type de bot
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur web démarré sur le port ${PORT}`);
});

// Fonction utilitaire pour valider un token Telegram
async function validateTelegramToken(token) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, {
      timeout: 10000
    });
    return response.data.ok ? response.data.result : false;
  } catch (error) {
    console.error('Erreur validation token Telegram:', error.message);
    return false;
  }
}

// Fonction pour analyser une URL GitHub
function parseGitHubUrl(url) {
  try {
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    
    const [, owner, repo] = match;
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  } catch (error) {
    return null;
  }
}

// Fonction pour exécuter une commande avec timeout et journalisation
function executeCommand(command, args, options, logFile, timeout = 300000) {
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

// Fonction pour déployer un bot
async function deployBot(botType, token, repoUrl, branch, startCommand, buildCommand, envVars, ctx) {
  const message = await ctx.reply('🔄 Début du déploiement...');
  const messageId = message.message_id;
  const chatId = ctx.chat.id;
  
  // Démarrer le déploiement en arrière-plan
  deployInBackground(botType, token, repoUrl, branch, startCommand, buildCommand, envVars, chatId, messageId);
  
  return { success: true, message: 'Déploiement démarré en arrière-plan. Vous serez notifié à la fin.' };
}

// Fonction pour déployer en arrière-plan
async function deployInBackground(botType, token, repoUrl, branch, startCommand, buildCommand, envVars, chatId, messageId) {
  let botName = '';
  let botFolder = '';
  let logFile = '';
  let deploymentLog = '';
  
  try {
    // Mettre à jour le message de statut
    await updateDeploymentStatus(chatId, messageId, '🔍 Validation des paramètres...');
    
    // Valider selon le type de bot
    let botInfo = null;
    if (botType === 'telegram') {
      if (!token) {
        throw new Error('Token requis pour les bots Telegram');
      }
      
      botInfo = await validateTelegramToken(token);
      if (!botInfo) {
        throw new Error('Token Telegram invalide');
      }
      
      deploymentLog += `✅ Token Telegram validé: ${botInfo.first_name} (@${botInfo.username})\n`;
    } else if (botType === 'whatsapp') {
      // Pour WhatsApp, on n'a pas besoin de token mais on peut faire d'autres validations
      deploymentLog += '✅ Déploiement WhatsApp configuré\n';
    } else {
      throw new Error('Type de bot non supporté');
    }
    
    // Vérifier si le bot existe déjà (pour Telegram avec token)
    if (botType === 'telegram') {
      const existingBot = await new Promise((resolve) => {
        db.get('SELECT * FROM bots WHERE token = ?', [token], (err, row) => {
          resolve(row);
        });
      });

      if (existingBot) {
        throw new Error('Ce token est déjà utilisé par un autre bot');
      }
    }
    
    // Créer le dossier d'instance
    botName = `${botType}-${uuidv4().substring(0, 8)}`;
    botFolder = path.join(INSTANCES_DIR, botName);
    await fs.ensureDir(botFolder);
    
    // Créer le fichier de log
    logFile = path.join(LOGS_DIR, `${botName}.log`);
    await fs.ensureDir(path.dirname(logFile));
    
    await updateDeploymentStatus(chatId, messageId, '📥 Clonage du repository...');
    
    // Cloner le repo avec timeout
    await executeCommand('git', ['clone', '--depth', '1', '-b', branch, repoUrl, botFolder], {}, logFile, 300000);
    deploymentLog += `✅ Repository cloné: ${repoUrl} (branche: ${branch})\n`;
    
    await updateDeploymentStatus(chatId, messageId, '⚙️ Configuration de l\'environnement...');
    
    // Créer le fichier .env
    let envContent = `NODE_ENV=production\n`;
    
    if (botType === 'telegram') {
      envContent += `BOT_TOKEN=${token}\n`;
    }
    
    // Ajouter les variables d'environnement personnalisées
    if (envVars) {
      const vars = envVars.split(',');
      for (const envVar of vars) {
        const [key, value] = envVar.split('=');
        if (key && value) {
          envContent += `${key}=${value}\n`;
        }
      }
    }
    
    await fs.writeFile(path.join(botFolder, '.env'), envContent);
    deploymentLog += '✅ Fichier .env créé\n';
    
    // Exécuter la commande de build si spécifiée
    if (buildCommand) {
      await updateDeploymentStatus(chatId, messageId, '📦 Installation des dépendances...');
      
      const [cmd, ...args] = buildCommand.split(' ');
      await executeCommand(cmd, args, { cwd: botFolder }, logFile, 360000);
      deploymentLog += `✅ Build command exécutée: ${buildCommand}\n`;
    }
    
    await updateDeploymentStatus(chatId, messageId, '🚀 Démarrage de l\'instance...');
    
    // Démarrer le bot
    const [cmd, ...args] = startCommand.split(' ');
    const child = spawn(cmd, args, {
      cwd: botFolder,
      env: { ...process.env, ...processEnvFromContent(envContent) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    
    // Rediriger les logs vers un fichier
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    
    // Attendre un peu pour que le bot démarre
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Vérifier que le bot fonctionne
    let isRunning = false;
    if (botType === 'telegram') {
      isRunning = await validateTelegramToken(token);
    } else {
      // Pour WhatsApp, on vérifie que le processus est toujours en cours d'exécution
      isRunning = !child.exitCode;
    }
    
    if (!isRunning) {
      throw new Error('Le bot ne répond pas après le démarrage');
    }
    
    // Enregistrer le bot dans la base de données
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO bots (name, token, folder, status, pid, username, first_name, log_file, repo_url, branch, start_command, build_command, env_vars, deployment_log, last_deployed, bot_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          botName,
          token,
          botFolder,
          'running',
          child.pid,
          botInfo ? botInfo.username : null,
          botInfo ? botInfo.first_name : null,
          logFile,
          repoUrl,
          branch,
          startCommand,
          buildCommand,
          envVars,
          deploymentLog,
          new Date().toISOString(),
          botType
        ],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    // Message de succès
    await updateDeploymentStatus(
      chatId, 
      messageId,
      `✅ Bot ${botType} déployé avec succès!\n\n📁 Dossier: ${botName}\n📊 Consultez les logs pour plus de détails.`
    );
    
  } catch (error) {
    console.error('Erreur lors du déploiement:', error);
    
    // Nettoyer les fichiers en cas d'erreur
    if (botFolder && await fs.pathExists(botFolder)) {
      await fs.remove(botFolder).catch(() => {});
    }
    
    // Message d'erreur
    try {
      await updateDeploymentStatus(
        chatId, 
        messageId,
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

// Fonction pour mettre à jour le statut du déploiement
async function updateDeploymentStatus(chatId, messageId, text) {
  try {
    await bot.telegram.editMessageText(chatId, messageId, null, text);
  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut:', error);
    // En cas d'erreur, envoyer un nouveau message
    await bot.telegram.sendMessage(chatId, text);
  }
}

// Fonction pour convertir le contenu env en objet process.env
function processEnvFromContent(envContent) {
  const env = {};
  const lines = envContent.split('\n');
  
  for (const line of lines) {
    const [key, value] = line.split('=');
    if (key && value) {
      env[key] = value;
    }
  }
  
  return env;
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
        const [cmd, ...args] = row.start_command.split(' ');
        const child = spawn(cmd, args, {
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
        db.run(
          'UPDATE bots SET status = ?, pid = ?, restarts_count = restarts_count + 1, last_restart = ? WHERE id = ?', 
          ['running', child.pid, new Date().toISOString(), botId]
        );

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
        const tokenPreview = bot.token ? bot.token.substring(0, 6) + '...' + bot.token.substring(bot.token.length - 4) : 'N/A';
        message += `🤖 ${bot.first_name || bot.name} (${bot.bot_type})\n`;
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
        let status = '🔴 Statut inconnu';
        
        if (row.bot_type === 'telegram') {
          // Vérifier si le bot Telegram répond
          const botInfo = await validateTelegramToken(row.token);
          status = botInfo ? '🟢 En ligne et répond' : '🔴 Arrêté ou ne répond pas';
        } else {
          // Pour WhatsApp, vérifier si le processus est en cours d'exécution
          if (row.pid) {
            try {
              process.kill(row.pid, 0); // Vérifie si le processus existe
              status = '🟢 En ligne (processus actif)';
            } catch (e) {
              status = '🔴 Processus arrêté';
            }
          } else {
            status = '🔴 Aucun processus';
          }
        }
        
        resolve({ 
          success: true, 
          message: `📊 Statut de ${row.first_name || row.name} (${row.bot_type}):\n${status}\n📍 Dernière vérification: ${new Date().toLocaleString()}\n📁 Dossier: ${row.name}\n🆔 ID: ${row.id}` 
        });
      } catch (error) {
        resolve({ success: false, message: '❌ Erreur: ' + error.message });
      }
    });
  });
}

// Fonction pour obtenir les logs d'un bot
async function getBotLogs(botId, lines = 50) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM bots WHERE id = ?', [botId], async (err, row) => {
      if (err || !row) {
        resolve({ success: false, message: '❌ Bot non trouvé' });
        return;
      }

      try {
        if (!await fs.pathExists(row.log_file)) {
          resolve({ success: false, message: '❌ Fichier de logs introuvable' });
          return;
        }

        const logContent = await fs.readFile(row.log_file, 'utf8');
        const logLines = logContent.split('\n').filter(line => line.trim());
        const lastLines = logLines.slice(-lines).join('\n');
        
        resolve({ success: true, message: `📋 Logs de ${row.name} (${lines} dernières lignes):\n\n${lastLines}` });
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
  const welcomeText = `🤖 *Bot Déployeur Universel Avancé* 🤖\n\n` +
    `Je peux vous aider à déployer et gérer vos bots Telegram et WhatsApp automatiquement.\n\n` +
    `*Commandes disponibles:*\n` +
    `/newbot - Déployer une nouvelle instance\n` +
    `/mybots - Lister vos bots déployés\n` +
    `/stopbot <id> - Arrêter un bot\n` +
    `/restartbot <id> - Redémarrer un bot\n` +
    `/status <id> - Vérifier le statut d'un bot\n` +
    `/logs <id> [lignes] - Voir les logs d'un bot\n` +
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
  // Mode interactif pour créer un nouveau bot
  const chatId = ctx.chat.id;
  const messageId = ctx.message.message_id;
  
  // Demander le type de bot
  await ctx.reply('🤖 Quel type de bot souhaitez-vous déployer?', Markup.inlineKeyboard([
    [Markup.button.callback('Telegram Bot', 'deploy_telegram')],
    [Markup.button.callback('WhatsApp Bot', 'deploy_whatsapp')],
    [Markup.button.callback('🔙 Annuler', 'main_menu')]
  ]));
});

bot.command('mybots', async (ctx) => {
  const result = await listBots(ctx);
  
  if (result.bots && result.bots.length > 0) {
    // Créer des boutons pour chaque bot
    const buttons = result.bots.map(bot => [
      Markup.button.callback(`${bot.first_name || bot.name} (${bot.bot_type})`, `bot_detail_${bot.id}`)
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

bot.command('logs', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const botId = args[1];
  const lines = args[2] || 50;
  
  if (!botId || isNaN(botId)) {
    return ctx.reply('❌ Usage: /logs <id> [lignes]\n\nUtilisez /mybots pour obtenir les IDs de vos bots.');
  }
  
  const result = await getBotLogs(botId, parseInt(lines));
  
  if (result.message.length > 4096) {
    // Si les logs sont trop longs, les envoyer par parties
    const parts = result.message.match(/[\s\S]{1,4096}/g) || [];
    for (let i = 0; i < parts.length; i++) {
      await ctx.reply(parts[i] + (i === parts.length - 1 ? '' : '...'));
    }
  } else {
    ctx.reply(result.message);
  }
});

bot.command('menu', async (ctx) => {
  const menuText = '🎮 Menu de gestion des bots';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
    [Markup.button.callback('📋 Voir mes bots', 'list_bots')],
    [Markup.button.callback('🔄 Redémarrer un bot', 'restart_bot_menu')],
    [Markup.button.callback('🛑 Arrêter un bot', 'stop_bot_menu')],
    [Markup.button.callback('📊 Voir les logs', 'logs_menu')]
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
  
  const menuText = '🤖 *Bot Déployeur Universel Avancé* 🤖\n\nQue souhaitez-vous faire?';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Déployer un bot', 'deploy_bot')],
    [Markup.button.callback('📋 Voir mes bots', 'list_bots')],
    [Markup.button.callback('🔄 Redémarrer un bot', 'restart_bot_menu')],
    [Markup.button.callback('🛑 Arrêter un bot', 'stop_bot_menu')],
    [Markup.button.callback('📊 Voir les logs', 'logs_menu')]
  ]);
  
  await ctx.reply(menuText, { 
    parse_mode: 'Markdown',
    reply_markup: keyboard.reply_markup 
  });
});

bot.action('deploy_bot', async (ctx) => {
  await ctx.answerCbQuery();
  
  const messageText = '🤖 Quel type de bot souhaitez-vous déployer?';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Telegram Bot', 'deploy_telegram')],
    [Markup.button.callback('WhatsApp Bot', 'deploy_whatsapp')],
    [Markup.button.callback('🔙 Retour au menu', 'main_menu')]
  ]);
  
  await safeEditMessage(ctx, messageText, keyboard);
});

bot.action('deploy_telegram', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Stocker le type de bot dans la session
  ctx.session.botType = 'telegram';
  
  const messageText = '🤖 Déploiement d\'un bot Telegram\n\nVeuillez envoyer le token de votre bot Telegram.\n\nVous pouvez obtenir un token auprès de @BotFather.';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Retour', 'deploy_bot')]
  ]);
  
  await safeEditMessage(ctx, messageText, keyboard);
});

bot.action('deploy_whatsapp', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Stocker le type de bot dans la session
  ctx.session.botType = 'whatsapp';
  ctx.session.botConfig = {
    repoUrl: DEFAULT_WHATSAPP_REPO,
    branch: 'main',
    startCommand: 'npm start',
    buildCommand: 'npm install'
  };
  
  const messageText = '🤖 Déploiement d\'un bot WhatsApp\n\nVeuillez envoyer l\'URL du repository GitHub de votre bot WhatsApp.';
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Utiliser le template par défaut', 'use_default_whatsapp')],
    [Markup.button.callback('🔙 Retour', 'deploy_bot')]
  ]);
  
  await safeEditMessage(ctx, messageText, keyboard);
});

bot.action('use_default_whatsapp', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Utiliser le template par défaut pour WhatsApp
  ctx.session.botConfig.repoUrl = DEFAULT_WHATSAPP_REPO;
  
  const messageText = `✅ Template WhatsApp par défaut sélectionné: ${DEFAULT_WHATSAPP_REPO}\n\nVeuillez maintenant envoyer la branche à utiliser (par défaut: main).`;
  
  await safeEditMessage(ctx, messageText);
});

// Gestion des messages pour la configuration interactive
bot.on('text', async (ctx) => {
  // Vérifier si nous sommes en mode configuration de bot
  if (ctx.session.botType) {
    const text = ctx.message.text;
    
    if (ctx.session.botType === 'telegram') {
      if (!ctx.session.botConfig) {
        // Premier message: le token
        ctx.session.botConfig = {
          token: text,
          repoUrl: DEFAULT_TELEGRAM_REPO,
          branch: 'main',
          startCommand: 'npm start',
          buildCommand: 'npm install'
        };
        
        await ctx.reply('✅ Token reçu. Veuillez maintenant envoyer l\'URL du repository GitHub (ou appuyez sur /default pour utiliser le template par défaut).');
      } else if (!ctx.session.botConfig.repoUrl) {
        // Deuxième message: l'URL du repo
        if (text === '/default') {
          ctx.session.botConfig.repoUrl = DEFAULT_TELEGRAM_REPO;
        } else {
          ctx.session.botConfig.repoUrl = text;
        }
        
        await ctx.reply('✅ URL du repository reçue. Veuillez maintenant envoyer la branche à utiliser (par défaut: main).');
      } else if (!ctx.session.botConfig.branch) {
        // Troisième message: la branche
        ctx.session.botConfig.branch = text || 'main';
        await ctx.reply('✅ Branche reçue. Veuillez maintenant envoyer la commande de démarrage (par défaut: npm start).');
      } else if (!ctx.session.botConfig.startCommand) {
        // Quatrième message: la commande de démarrage
        ctx.session.botConfig.startCommand = text || 'npm start';
        await ctx.reply('✅ Commande de démarrage reçue. Veuillez maintenant envoyer la commande de build (par défaut: npm install).');
      } else if (!ctx.session.botConfig.buildCommand) {
        // Cinquième message: la commande de build
        ctx.session.botConfig.buildCommand = text || 'npm install';
        await ctx.reply('✅ Commande de build reçue. Souhaitez-vous ajouter des variables d\'environnement supplémentaires? (Format: KEY1=VALUE1,KEY2=VALUE2)');
      } else if (!ctx.session.botConfig.envVars) {
        // Sixième message: les variables d'environnement
        ctx.session.botConfig.envVars = text;
        
        // Résumé de la configuration
        await ctx.reply(`📋 Résumé de la configuration:\n\n` +
          `Type: ${ctx.session.botType}\n` +
          `Token: ${ctx.session.botConfig.token.substring(0, 10)}...\n` +
          `Repo: ${ctx.session.botConfig.repoUrl}\n` +
          `Branche: ${ctx.session.botConfig.branch}\n` +
          `Start: ${ctx.session.botConfig.startCommand}\n` +
          `Build: ${ctx.session.botConfig.buildCommand}\n` +
          `Variables: ${ctx.session.botConfig.envVars || 'Aucune'}\n\n` +
          `Confirmez-vous le déploiement?`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirmer', 'confirm_deployment')],
            [Markup.button.callback('❌ Annuler', 'cancel_deployment')]
          ]));
      }
    } else if (ctx.session.botType === 'whatsapp') {
      if (!ctx.session.botConfig.repoUrl) {
        // Premier message: l'URL du repo
        ctx.session.botConfig.repoUrl = text;
        await ctx.reply('✅ URL du repository reçue. Veuillez maintenant envoyer la branche à utiliser (par défaut: main).');
      } else if (!ctx.session.botConfig.branch) {
        // Deuxième message: la branche
        ctx.session.botConfig.branch = text || 'main';
        await ctx.reply('✅ Branche reçue. Veuillez maintenant envoyer la commande de démarrage (par défaut: npm start).');
      } else if (!ctx.session.botConfig.startCommand) {
        // Troisième message: la commande de démarrage
        ctx.session.botConfig.startCommand = text || 'npm start';
        await ctx.reply('✅ Commande de démarrage reçue. Veuillez maintenant envoyer la commande de build (par défaut: npm install).');
      } else if (!ctx.session.botConfig.buildCommand) {
        // Quatrième message: la commande de build
        ctx.session.botConfig.buildCommand = text || 'npm install';
        await ctx.reply('✅ Commande de build reçue. Souhaitez-vous ajouter des variables d\'environnement supplémentaires? (Format: KEY1=VALUE1,KEY2=VALUE2)');
      } else if (!ctx.session.botConfig.envVars) {
        // Cinquième message: les variables d'environnement
        ctx.session.botConfig.envVars = text;
        
        // Résumé de la configuration
        await ctx.reply(`📋 Résumé de la configuration:\n\n` +
          `Type: ${ctx.session.botType}\n` +
          `Repo: ${ctx.session.botConfig.repoUrl}\n` +
          `Branche: ${ctx.session.botConfig.branch}\n` +
          `Start: ${ctx.session.botConfig.startCommand}\n` +
          `Build: ${ctx.session.botConfig.buildCommand}\n` +
          `Variables: ${ctx.session.botConfig.envVars || 'Aucune'}\n\n` +
          `Confirmez-vous le déploiement?`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirmer', 'confirm_deployment')],
            [Markup.button.callback('❌ Annuler', 'cancel_deployment')]
          ]));
      }
    }
  }
});

bot.action('confirm_deployment', async (ctx) => {
  await ctx.answerCbQuery();
  
  const { botType, botConfig } = ctx.session;
  
  try {
    // Lancer le déploiement
    const result = await deployBot(
      botType,
      botConfig.token,
      botConfig.repoUrl,
      botConfig.branch,
      botConfig.startCommand,
      botConfig.buildCommand,
      botConfig.envVars,
      ctx
    );
    
    if (result.message) {
      await ctx.reply(result.message);
    }
    
    // Réinitialiser la session
    ctx.session = {};
  } catch (error) {
    await ctx.reply(`❌ Erreur lors du démarrage du déploiement: ${error.message}`);
  }
});

bot.action('cancel_deployment', async (ctx) => {
  await ctx.answerCbQuery();
  
  // Réinitialiser la session
  ctx.session = {};
  
  await ctx.reply('❌ Déploiement annulé.');
});

// Tâche cron pour vérifier l'état des bots
cron.schedule('*/5 * * * *', () => {
  console.log('🔍 Vérification de l\'état des bots...');
  
  db.all('SELECT * FROM bots WHERE status = "running"', async (err, rows) => {
    if (err) return;
    
    for (const bot of rows) {
      try {
        let isRunning = false;
        
        if (bot.bot_type === 'telegram') {
          // Vérifier les bots Telegram
          isRunning = await validateTelegramToken(bot.token);
        } else {
          // Vérifier les bots WhatsApp (vérification du processus)
          if (bot.pid) {
            try {
              process.kill(bot.pid, 0); // Vérifie si le processus existe
              isRunning = true;
            } catch (e) {
              isRunning = false;
            }
          }
        }
        
        if (!isRunning) {
          console.log(`❌ Bot ${bot.name} ne répond pas, redémarrage...`);
          
          // Redémarrer le bot
          const [cmd, ...args] = bot.start_command.split(' ');
          const child = spawn(cmd, args, {
            cwd: bot.folder,
            env: { ...process.env, BOT_TOKEN: bot.token },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
          });
          
          // Mettre à jour la base de données
          db.run(
            'UPDATE bots SET pid = ?, restarts_count = restarts_count + 1, last_restart = ? WHERE id = ?', 
            [child.pid, new Date().toISOString(), bot.id]
          );
        }
      } catch (error) {
        console.error(`Erreur lors de la vérification du bot ${bot.name}:`, error);
      }
    }
  });
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
  console.log('🤖 Bot Déployeur Universel Avancé démarré avec succès!');
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
