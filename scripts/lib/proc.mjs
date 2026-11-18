/**
 * 起外部进程并收集 stdout/stderr。
 *
 * 为什么不用 stdio:'pipe'：本机 DSH 沙箱（workspace-write）禁止子进程打开命名管道，
 * Node 的管道模式会直接 EPERM；重定向到普通文件在沙箱内外都成立，也顺带避开
 * 「输出太多把管道写满 → 父进程没读 → 死锁」这类经典问题。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hc-capture-'))
let seq = 0

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runProcess (cmd, args, options = {}) {
  const id = `${process.pid}-${++seq}`
  const outFile = path.join(captureDir, `${id}.out`)
  const errFile = path.join(captureDir, `${id}.err`)
  return (async () => {
    const outHandle = await fs.open(outFile, 'w')
    const errHandle = await fs.open(errFile, 'w')
    let child
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', outHandle.fd, errHandle.fd]
      })
    } finally {
      await outHandle.close()
      await errHandle.close()
    }
    return await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', async code => {
        let stdout = ''
        let stderr = ''
        try {
          stdout = await fs.readFile(outFile, 'utf8')
          stderr = await fs.readFile(errFile, 'utf8')
        } catch {}
        await fs.rm(outFile, { force: true }).catch(() => {})
        await fs.rm(errFile, { force: true }).catch(() => {})
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`${path.basename(cmd)} 退出码 ${code}\n${stderr.trim()}`))
      })
    })
  })()
}

export async function cleanupCapture () {
  await fs.rm(captureDir, { recursive: true, force: true }).catch(() => {})
}
