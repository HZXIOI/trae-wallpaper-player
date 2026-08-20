import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

const DEFAULT_TRAE_PATH = 'D:\\TRAE Word'
const SERVER_PORT = 9876
const SERVER_HOST = '127.0.0.1'

// Local server state
let currentVideoPath = ''
let currentOpacity = 20
let wss: WebSocketServer | null = null
let clients = new Set<WebSocket>()

const MARKER_START = '<!-- TRAE-WALLPAPER-PLAYER-START -->'
const MARKER_END = '<!-- TRAE-WALLPAPER-PLAYER-END -->'

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function startLocalServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/'

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url === '/wallpaper' || url.startsWith('/wallpaper')) {
      if (!currentVideoPath || !fs.existsSync(currentVideoPath)) {
        res.writeHead(404)
        res.end('No wallpaper set')
        return
      }

      const stat = fs.statSync(currentVideoPath)
      const ext = path.extname(currentVideoPath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo'
      }

      // Support range requests for seeking
      const range = req.headers.range
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
        const chunkSize = end - start + 1
        const fileStream = fs.createReadStream(currentVideoPath, { start, end })
        res.writeHead(206, {
          'Content-Type': mimeTypes[ext] || 'video/mp4',
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        })
        fileStream.pipe(res)
        fileStream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('Stream error')
          }
        })
        return
      }

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'video/mp4',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      })

      const stream = fs.createReadStream(currentVideoPath)
      stream.pipe(res)
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500)
          res.end('Stream error')
        }
      })
      return
    }

    if (url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hasWallpaper: !!currentVideoPath && fs.existsSync(currentVideoPath),
        opacity: currentOpacity,
        timestamp: Date.now()
      }))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    clients.add(ws)

    // Push current state to newly connected clients
    if (currentVideoPath) {
      ws.send(JSON.stringify({
        type: 'reload',
        opacity: currentOpacity,
        timestamp: Date.now()
      }))
    }

    ws.on('close', () => clients.delete(ws))
  })

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    console.log(`Trae Wallpaper Server running at http://${SERVER_HOST}:${SERVER_PORT}`)
  })
}

function broadcastReload(opacity?: number) {
  const message = JSON.stringify({
    type: 'reload',
    opacity: opacity !== undefined ? opacity : currentOpacity,
    timestamp: Date.now()
  })

  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  })
}

function broadcastRestore() {
  const message = JSON.stringify({
    type: 'restore',
    timestamp: Date.now()
  })

  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  })
}

app.whenReady().then(() => {
  createWindow()
  startLocalServer()
})

app.on('window-all-closed', () => {
  if (wss) wss.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

function sendProgress(message: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', message)
  }
}

ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    title: '选择壁纸视频'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('select-wallpaper-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: '选择壁纸文件夹'
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('get-default-folder', async () => {
  return path.join(DEFAULT_TRAE_PATH, 'resources', 'app', 'out', 'vs', 'workbench', 'browser', 'media', 'TraeWallpaperPool')
})

ipcMain.handle('ensure-folder', async (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }
    return { success: true, folderPath }
  } catch (err) {
    return { success: false, message: `创建文件夹失败: ${err}` }
  }
})

ipcMain.handle('get-videos-from-folder', async (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) {
      return []
    }
    const files = fs.readdirSync(folderPath)
    const videoExts = ['.mp4', '.webm', '.mov', '.mkv', '.avi']
    return files
      .filter(f => videoExts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stat = fs.statSync(path.join(folderPath, f))
        return {
          name: f,
          path: path.join(folderPath, f),
          size: stat.size,
          modified: stat.mtimeMs
        }
      })
      .sort((a, b) => b.modified - a.modified)
  } catch (err) {
    return []
  }
})

ipcMain.handle('import-video', async (_event, options: { sourcePath: string; folderPath?: string }) => {
  try {
    const { sourcePath } = options
    if (!fs.existsSync(sourcePath)) {
      return { success: false, message: '源视频文件不存在' }
    }

    const destFolder = options.folderPath || path.join(DEFAULT_TRAE_PATH, 'resources', 'app', 'out', 'vs', 'workbench', 'browser', 'media', 'TraeWallpaperPool')
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true })
    }

    const ext = path.extname(sourcePath)
    const base = path.basename(sourcePath, ext)
    let destName = `${base}${ext}`
    let destPath = path.join(destFolder, destName)
    let counter = 1

    while (fs.existsSync(destPath)) {
      destName = `${base} (${counter})${ext}`
      destPath = path.join(destFolder, destName)
      counter++
    }

    fs.copyFileSync(sourcePath, destPath)
    const stat = fs.statSync(destPath)
    return {
      success: true,
      item: {
        name: destName,
        path: destPath,
        size: stat.size,
        modified: stat.mtimeMs
      }
    }
  } catch (err) {
    return { success: false, message: `导入失败: ${err}` }
  }
})

ipcMain.handle('apply-wallpaper', async (_event, options: { videoPath: string; opacity: number; traPath?: string }) => {
  try {
    const traPath = options.traPath || DEFAULT_TRAE_PATH
    const resourcesPath = path.join(traPath, 'resources', 'app', 'out', 'vs')
    const soloLitePath = path.join(resourcesPath, 'code', 'electron-browser', 'solo', 'solo-lite.html')
    const mediaPath = path.join(resourcesPath, 'workbench', 'browser', 'media')
    const cssPath = path.join(mediaPath, 'trae-skin.css')

    if (!fs.existsSync(soloLitePath)) {
      return { success: false, message: `找不到 Trae 入口文件: ${soloLitePath}` }
    }

    if (!fs.existsSync(options.videoPath)) {
      return { success: false, message: `视频文件不存在: ${options.videoPath}` }
    }

    // Make sure we have a clean backup to restore later
    const bakPath = `${soloLitePath}.bak`
    if (!fs.existsSync(bakPath)) {
      sendProgress('正在备份原文件...')
      const clean = cleanInjection(fs.readFileSync(soloLitePath, 'utf-8'))
      fs.writeFileSync(bakPath, clean, 'utf-8')
    }

    // Only inject once; afterwards switching is instant via WebSocket
    const alreadyInjected = fs.readFileSync(soloLitePath, 'utf-8').includes(MARKER_START)
    if (!alreadyInjected) {
      sendProgress('正在首次配置 Trae...')
      injectIntoSoloLite(soloLitePath, generateVideoHTML())
    }

    sendProgress('正在更新服务器...')
    currentVideoPath = options.videoPath
    currentOpacity = options.opacity

    sendProgress('正在生成 CSS...')
    fs.writeFileSync(cssPath, generateCSS(options.opacity), 'utf-8')

    sendProgress('正在刷新背景...')
    broadcastReload(options.opacity)

    return { success: true, message: '壁纸已应用，Trae 背景已刷新' }
  } catch (err) {
    return { success: false, message: `应用失败: ${err}` }
  }
})

ipcMain.handle('restore-default', async (_event, traPath?: string) => {
  try {
    const targetTraPath = traPath || DEFAULT_TRAE_PATH
    const soloLitePath = path.join(targetTraPath, 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'solo', 'solo-lite.html')
    const cssPath = path.join(targetTraPath, 'resources', 'app', 'out', 'vs', 'workbench', 'browser', 'media', 'trae-skin.css')

    const cleanContent = getCleanOriginalContent(soloLitePath)
    fs.writeFileSync(soloLitePath, cleanContent, 'utf-8')

    if (fs.existsSync(cssPath)) {
      fs.unlinkSync(cssPath)
    }

    currentVideoPath = ''
    broadcastRestore()

    return { success: true, message: '已恢复默认，无需重启 Trae' }
  } catch (err) {
    return { success: false, message: `恢复失败: ${err}` }
  }
})

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  await shell.openPath(folderPath)
})

function getCleanOriginalContent(soloLitePath: string): string {
  const bakPath = `${soloLitePath}.bak`
  if (fs.existsSync(bakPath)) {
    return fs.readFileSync(bakPath, 'utf-8')
  }

  const backupPath = `${soloLitePath}.backup`
  if (fs.existsSync(backupPath)) {
    return cleanInjection(fs.readFileSync(backupPath, 'utf-8'))
  }

  return cleanInjection(fs.readFileSync(soloLitePath, 'utf-8'))
}

function cleanInjection(content: string): string {
  // Remove marker blocks
  const markerRegex = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}\\s*`, 'g')
  content = content.replace(markerRegex, '')

  // Remove legacy injections for compatibility
  content = content.replace(/<link[^>]*trae-skin\.css[^>]*>\s*/gi, '')
  content = content.replace(/<video id="trae-skin-bg"[\s\S]*?<\/video>\s*/gi, '')
  content = content.replace(/<style id="trae-skin-style">[\s\S]*?<\/style>\s*/gi, '')
  // Remove any scripts that reference the injected video element
  content = content.replace(/<script[^>]*>[\s\S]*?trae-skin-bg[\s\S]*?<\/script>\s*/gi, '')

  return content
}

function injectIntoSoloLite(soloLitePath: string, videoHTML: string) {
  let content = fs.readFileSync(soloLitePath, 'utf-8')
  content = cleanInjection(content)

  const cssLink = `${MARKER_START}\n<link rel="stylesheet" href="../../../workbench/browser/media/trae-skin.css" id="trae-skin-link">\n${MARKER_END}`
  const bodyBlock = `${MARKER_START}\n${videoHTML}\n${MARKER_END}`

  content = content.replace('</head>', `${cssLink}\n</head>`)
  content = content.replace('</body>', `${bodyBlock}\n</body>`)

  fs.writeFileSync(soloLitePath, content, 'utf-8')
}

function generateCSS(opacity: number): string {
  return `/* Trae Wallpaper Player - Auto generated */
#trae-skin-bg {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  object-fit: cover !important;
  z-index: 99999 !important;
  opacity: ${opacity / 100} !important;
  pointer-events: none !important;
}`
}

function getVideoMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/mp4',
    '.avi': 'video/x-msvideo'
  }
  return mimeTypes[ext] || 'video/mp4'
}

function generateVideoHTML(): string {
  const sourceType = currentVideoPath ? getVideoMimeType(currentVideoPath) : 'video/mp4'
  return `<video id="trae-skin-bg" autoplay muted loop playsinline>
  <source src="http://${SERVER_HOST}:${SERVER_PORT}/wallpaper" type="${sourceType}">
</video>
<script>
(function() {
  const video = document.getElementById('trae-skin-bg');
  const source = video.querySelector('source');
  let reconnectTimer = null;
  let ws = null;

  function setOpacity(opacity) {
    if (typeof opacity === 'number') {
      video.style.setProperty('opacity', (opacity / 100).toString(), 'important');
    }
  }

  function connect() {
    ws = new WebSocket('ws://${SERVER_HOST}:${SERVER_PORT}');
    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'reload') {
          source.src = 'http://${SERVER_HOST}:${SERVER_PORT}/wallpaper?t=' + data.timestamp;
          video.load();
          video.play();
          if (data.opacity !== undefined) {
            setOpacity(data.opacity);
          }
        } else if (data.type === 'restore') {
          video.remove();
          const link = document.getElementById('trae-skin-link');
          if (link) link.remove();
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (ws) ws.close();
        }
      } catch (e) {}
    };
    ws.onclose = function() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
  }
  connect();
})();
</script>`
}
