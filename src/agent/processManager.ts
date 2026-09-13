import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

export type ProcessState = 'running' | 'exited' | 'stale';

export interface ProcessLogEntry {
  source: 'stdout' | 'stderr';
  text: string;
  timestamp: number;
}

export interface ManagedProcess {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  child: ChildProcess | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | string | null;
  status: ProcessState;
  logs: ProcessLogEntry[];
}

export interface ProcessStatusResult {
  ok: boolean;
  process_id: string;
  pid: number;
  command: string;
  cwd: string;
  status: ProcessState;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | string | null;
  uptimeMs: number;
}

export interface StopProcessResult {
  ok: boolean;
  process_id: string;
  status: ProcessState;
  message: string;
  error?: string;
}

/**
 * Baseline pattern untuk redaksi kredensial (case-insensitive):
 * /(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi
 */
export const CREDENTIAL_REDACT_REGEX =
  /(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi;

/**
 * Sanitasi kredensial pada teks log (best-effort).
 *
 * CATATAN KEAMANAN & BATASAN:
 * Redaksi kredensial ini mengganti nilai sensitif setelah key (seperti api_key, token, password,
 * secret, authorization) menjadi [REDACTED].
 * Pendekatan ini adalah pertahanan berlapis (defense-in-depth) yang bersifat BEST-EFFORT,
 * bukan jaminan mutlak 100% bahwa semua format kredensial arbitrer akan tertangkap
 * (misalnya token tanpa penanda eksplisit atau format khusus non-standar bisa lolos),
 * selaras dengan dokumentasi batasan TOCTOU pada SSRF guard sebelumnya.
 */
export function redactCredentials(text: string): string {
  return text.replace(
    /(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)\S+/gi,
    '$1$2[REDACTED]',
  );
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private idCounter = 0;
  private hooksRegistered = false;

  private exitHandler = (): void => {
    this.cleanupAllSync();
  };

  private sigintHandler = (): void => {
    this.cleanupAllSync();
    process.exit(130);
  };

  private sigtermHandler = (): void => {
    this.cleanupAllSync();
    process.exit(143);
  };

  constructor() {
    this.registerLifecycleHooks();
  }

  /**
   * Mendaftarkan Anti-Zombie Lifecycle Hooks pada process.on('exit'),
   * process.on('SIGINT'), dan process.on('SIGTERM').
   * Menjamin child process tidak tertinggal menjadi zombie bila Ruko dimatikan
   * via Ctrl+C maupun sinyal kill (SIGTERM).
   */
  public registerLifecycleHooks(): void {
    if (this.hooksRegistered) return;
    this.hooksRegistered = true;
    process.on('exit', this.exitHandler);
    process.on('SIGINT', this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);
  }

  /**
   * Menghapus listener sinyal untuk isolasi unit test.
   */
  public removeLifecycleHooks(): void {
    if (!this.hooksRegistered) return;
    process.removeListener('exit', this.exitHandler);
    process.removeListener('SIGINT', this.sigintHandler);
    process.removeListener('SIGTERM', this.sigtermHandler);
    this.hooksRegistered = false;
  }

  /**
   * Mengembalikan daftar seluruh proses yang berstatus 'running'.
   * Otomatis memvalidasi keberadaan PID di OS untuk mendeteksi status 'stale'.
   */
  public getActiveProcesses(): ManagedProcess[] {
    const active: ManagedProcess[] = [];
    for (const proc of this.processes.values()) {
      if (proc.status === 'running') {
        let alive = true;
        try {
          process.kill(proc.pid, 0);
        } catch (err: any) {
          if (err && (err.code === 'ESRCH' || err.message?.includes('ESRCH'))) {
            alive = false;
          }
        }
        if (!alive) {
          proc.status = 'stale';
        } else {
          active.push(proc);
        }
      }
    }
    return active;
  }

  /**
   * Memeriksa apakah process_id terdaftar dalam sistem.
   */
  public hasProcess(processId: string): boolean {
    return this.processes.has(processId);
  }

  /**
   * Mengambil detail ManagedProcess internal.
   */
  public getProcess(processId: string): ManagedProcess | undefined {
    return this.processes.get(processId);
  }

  /**
   * Menambahkan entri log ke ring buffer (maks 100 baris terbaru).
   */
  private appendLog(proc: ManagedProcess, source: 'stdout' | 'stderr', line: string): void {
    proc.logs.push({
      source,
      text: line,
      timestamp: Date.now(),
    });
    if (proc.logs.length > 100) {
      proc.logs.splice(0, proc.logs.length - 100);
    }
  }

  /**
   * Menjalankan perintah shell sebagai detached child process (non-blocking).
   */
  public startProcess(command: string, cwd: string): ManagedProcess {
    const active = this.getActiveProcesses();
    if (active.length >= 3) {
      const activeList = active
        .map((p) => `${p.id} (PID ${p.pid}, cmd: "${p.command}")`)
        .join(', ');
      throw new Error(
        `Batas maksimal 3 proses aktif tercapai. Proses aktif saat ini: ${activeList}. Silakan gunakan stop_process(<process_id>) untuk menghentikan salah satu proses terlebih dahulu.`,
      );
    }

    const id = `proc_${++this.idCounter}`;

    const child = spawn(command, {
      shell: true,
      detached: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) {
      throw new Error(`Gagal memulai child process untuk perintah "${command}" (tidak ada PID).`);
    }

    // child.unref() agar tidak mengunci Node event loop jika process utama selesai
    child.unref();

    const proc: ManagedProcess = {
      id,
      pid: child.pid,
      command,
      cwd,
      startTime: Date.now(),
      child,
      exitCode: null,
      exitSignal: null,
      status: 'running',
      logs: [],
    };

    if (child.stdout) {
      let stdoutBuf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          this.appendLog(proc, 'stdout', line);
        }
      });
      child.stdout.on('end', () => {
        if (stdoutBuf.length > 0) {
          this.appendLog(proc, 'stdout', stdoutBuf);
          stdoutBuf = '';
        }
      });
    }

    if (child.stderr) {
      let stderrBuf = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          this.appendLog(proc, 'stderr', line);
        }
      });
      child.stderr.on('end', () => {
        if (stderrBuf.length > 0) {
          this.appendLog(proc, 'stderr', stderrBuf);
          stderrBuf = '';
        }
      });
    }

    child.on('exit', (code, signal) => {
      proc.exitCode = code;
      proc.exitSignal = signal;
      proc.status = 'exited';
    });

    child.on('error', (err) => {
      this.appendLog(proc, 'stderr', `Process error: ${err.message}`);
      proc.status = 'exited';
    });

    this.processes.set(id, proc);
    return proc;
  }

  /**
   * Membaca isi ring buffer log (maksimal 100 baris terbaru) dengan redaksi kredensial.
   * Mengembalikan null jika processId tidak ditemukan.
   */
  public readProcessLogs(processId: string): string[] | null {
    const proc = this.processes.get(processId);
    if (!proc) return null;
    return proc.logs.map((entry) => {
      const raw = `[${entry.source}] ${entry.text}`;
      return redactCredentials(raw);
    });
  }

  /**
   * Mengembalikan status deterministik: 'running', 'exited', atau 'stale'.
   * Mengembalikan null jika processId tidak ditemukan.
   */
  public getProcessStatus(processId: string): ProcessStatusResult | null {
    const proc = this.processes.get(processId);
    if (!proc) return null;

    if (proc.status === 'running') {
      let alive = true;
      try {
        process.kill(proc.pid, 0);
      } catch (err: any) {
        if (err && (err.code === 'ESRCH' || err.message?.includes('ESRCH'))) {
          alive = false;
        }
      }
      if (!alive) {
        proc.status = 'stale';
      }
    }

    return {
      ok: true,
      process_id: proc.id,
      pid: proc.pid,
      command: proc.command,
      cwd: proc.cwd,
      status: proc.status,
      exitCode: proc.exitCode,
      exitSignal: proc.exitSignal,
      uptimeMs: Date.now() - proc.startTime,
    };
  }

  /**
   * Menghentikan proses yang sedang berjalan.
   * Alur: Kirim SIGTERM terlebih dahulu. Jika proses belum berhenti dalam timeoutMs (default 5s),
   * kirim sinyal SIGKILL paksa.
   *
   * CATATAN KEAMANAN:
   * Pemanggilan stop_process TIDAK memerlukan Approval Gate [Y/N].
   * Alasan: Menghentikan proses bersifat non-destruktif terhadap file/data user,
   * berbeda dari start_process yang berpotensi memiliki efek samping tidak terduga.
   * Asimetri ini disengaja, bukan kelalaian.
   */
  public async stopProcess(
    processId: string,
    timeoutMs: number = 5000,
  ): Promise<StopProcessResult> {
    const proc = this.processes.get(processId);
    if (!proc) {
      return {
        ok: false,
        process_id: processId,
        status: 'exited',
        message: `Proses dengan ID "${processId}" tidak ditemukan.`,
        error: `stop_process: proses dengan ID "${processId}" tidak ditemukan.`,
      };
    }

    if (proc.status === 'exited' || proc.status === 'stale') {
      return {
        ok: true,
        process_id: processId,
        status: proc.status,
        message: `Proses sudah tidak aktif (${proc.status}).`,
      };
    }

    const isProcessDead = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };

    // 1. Kirim SIGTERM
    try {
      if (process.platform !== 'win32') {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.child?.kill('SIGTERM');
        }
      } else {
        proc.child?.kill('SIGTERM');
      }
    } catch {
      // Abaikan jika proses sudah mati sesaat sebelum sinyal terkirim
    }

    // 2. Tunggu proses berhenti secara graceful hingga timeoutMs
    let exited = isProcessDead(proc.pid) || (proc.status as ProcessState) === 'exited';
    if (!exited) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if ((proc.status as ProcessState) === 'exited' || isProcessDead(proc.pid)) {
          exited = true;
          break;
        }
      }
    }

    // 3. Jika belum berhenti setelah timeout, kirim SIGKILL paksa
    if (!exited) {
      try {
        if (process.platform !== 'win32') {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            proc.child?.kill('SIGKILL');
          }
        } else {
          proc.child?.kill('SIGKILL');
        }
      } catch {
        // Abaikan error sinyal kill
      }

      const killDeadline = Date.now() + 1000;
      while (Date.now() < killDeadline) {
        await new Promise((r) => setTimeout(r, 50));
        if ((proc.status as ProcessState) === 'exited' || isProcessDead(proc.pid)) {
          exited = true;
          break;
        }
      }
    }

    proc.status = 'exited';
    return {
      ok: true,
      process_id: processId,
      status: 'exited',
      message: `Proses "${processId}" (PID ${proc.pid}) berhasil dihentikan.`,
    };
  }

  /**
   * Sinkron: Menghentikan seluruh proses aktif seketika (SIGTERM + SIGKILL)
   * untuk Anti-Zombie Lifecycle Hooks saat Ruko keluar.
   */
  public cleanupAllSync(): void {
    for (const proc of this.processes.values()) {
      if (proc.status === 'running') {
        try {
          if (process.platform !== 'win32') {
            try {
              process.kill(-proc.pid, 'SIGTERM');
            } catch {}
            try {
              process.kill(proc.pid, 'SIGTERM');
            } catch {}
            try {
              process.kill(-proc.pid, 'SIGKILL');
            } catch {}
            try {
              process.kill(proc.pid, 'SIGKILL');
            } catch {}
          } else {
            try {
              proc.child?.kill('SIGKILL');
            } catch {}
            try {
              process.kill(proc.pid, 'SIGKILL');
            } catch {}
          }
        } catch {
          // ignore cleanup errors
        }
        proc.status = 'exited';
      }
    }
  }

  /**
   * Reset seluruh state untuk pengujian.
   */
  public reset(): void {
    this.cleanupAllSync();
    this.processes.clear();
    this.idCounter = 0;
  }

  /**
   * Mendaftarkan proses tiruan/stale untuk pengujian atau pemulihan sesi.
   */
  public registerMockProcess(proc: ManagedProcess): void {
    this.processes.set(proc.id, proc);
  }
}

/** Singleton default process manager */
export const defaultProcessManager = new ProcessManager();
