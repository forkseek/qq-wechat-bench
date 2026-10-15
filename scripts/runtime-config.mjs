import { runtimeInfo } from '../lib/settings.mjs';
import { AppError } from '../lib/domain.mjs';

// 各启动器共用此只读入口；只返回地址和程序信息，不读取或输出私有密钥。
try { process.stdout.write(JSON.stringify(runtimeInfo()) + '\n'); }
catch (error) { process.stderr.write((error instanceof AppError ? error.message : '程序配置无法读取') + '\n'); process.exitCode = 1; }
