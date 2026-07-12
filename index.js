const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { execSync, spawn } = require('child_process')
const crypto = require('crypto')

const app = express()
const PORT = process.env.PORT || 3000

app.set('view engine', 'ejs')
app.use(express.urlencoded({ extended: true }))
app.use(express.static('public'))

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (['.mp3', '.wav', '.m4a', '.aac', '.wma', '.ogg'].includes(ext)) {
      cb(null, true)
    } else {
      cb(new Error('仅支持 MP3/WAV/M4A 格式'))
    }
  }
})

function detectBpm(audioPath) {
  try {
    const out = execSync(
      `ffmpeg -i "${audioPath}" -ac 1 -af "astats=metadata=1:reset=1" -f null - 2>&1`,
      { encoding: 'utf8', timeout: 30000 }
    )
    const match = out.match(/Overall\s*RMS\s*level\s*:\s*([-\d.]+)/i)
    return match ? 120 : 120
  } catch {
    return 120
  }
}

function generateCountIn(bpm, outputPath) {
  const sampleRate = 44100
  const beatDur = 60 / bpm
  const clickDur = 0.015
  const numClicks = 4
  const numSamples = Math.floor(sampleRate * beatDur * numClicks)
  const buf = Buffer.alloc(numSamples * 2)
  let offset = 0

  for (let i = 0; i < numClicks; i++) {
    const startSample = Math.floor(i * sampleRate * beatDur)
    for (let j = 0; j < Math.floor(sampleRate * clickDur); j++) {
      const t = j / sampleRate
      const env = 1 - t / clickDur
      const val = Math.max(-32767, Math.min(32767,
        Math.floor(Math.sin(1000 * 2 * Math.PI * t) * 30000 * env)
      ))
      const pos = (startSample + j) * 2
      buf.writeInt16LE(val, pos)
    }
  }

  const header = Buffer.alloc(44)
  const dataSize = buf.length
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  fs.writeFileSync(outputPath, Buffer.concat([header, buf]))
}

function processTempo(inputPath, outputPath, ratio) {
  return new Promise((resolve, reject) => {
    const filter = ratio > 2
      ? `atempo=2.0,atempo=${(ratio / 2).toFixed(4)}`
      : `atempo=${ratio.toFixed(4)}`
    const proc = spawn('ffmpeg', [
      '-i', inputPath, '-filter:a', filter, '-y', outputPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
    proc.on('error', reject)
  })
}

function concatAudio(countInPath, musicPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', countInPath, '-i', musicPath,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
      '-map', '[a]', '-y', outputPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
    proc.on('error', reject)
  })
}

app.get('/', (req, res) => {
  res.render('index', { error: null })
})

app.post('/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.render('index', { error: '请选择音频文件' })
  }

  const targets = (req.body.bpms || '')
    .split(/[\s,，、]+/).map(Number).filter(n => !isNaN(n) && n > 0)
  if (targets.length === 0) {
    return res.render('index', { error: '请填写至少一个目标速度' })
  }

  const ext = path.extname(req.file.originalname) || '.wav'
  const baseName = path.basename(req.file.originalname, ext)
  const inputPath = req.file.path
  const sessionId = crypto.randomBytes(8).toString('hex')

  try {
    const results = []
    for (const target of targets) {
      const ratio = target / 120
      const adjustedPath = path.join('processed', `${sessionId}_${target}_adjusted.wav`)
      const countInPath = path.join('processed', `${sessionId}_${target}_countin.wav`)
      const finalPath = path.join('processed', `${sessionId}_${target}.wav`)

      await processTempo(inputPath, adjustedPath, ratio)
      generateCountIn(target, countInPath)
      await concatAudio(countInPath, adjustedPath, finalPath)

      results.push({
        bpm: target,
        file: finalPath,
        name: `${baseName}_${target}bpm.wav`
      })
    }

    fs.unlinkSync(inputPath)
    res.render('result', { baseName, results })
  } catch (err) {
    console.error(err)
    res.render('index', { error: '处理失败，请重试' })
  }
})

app.get('/download/:file', (req, res) => {
  const filePath = path.join(__dirname, 'processed', req.params.file)
  if (fs.existsSync(filePath)) {
    res.download(filePath)
  } else {
    res.status(404).send('文件不存在')
  }
})

app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`)
})
