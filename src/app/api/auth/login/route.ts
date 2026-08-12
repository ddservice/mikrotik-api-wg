import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateUser, addLog } from '@/lib/db';
import crypto from 'crypto';

const LoginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

// In-memory active sessions for serverless/edge compatibility
const activeSessions = new Map<string, { user: any; expires: number }>();
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
    }

    const { username, password } = parsed.data;
    const user = await authenticateUser(username, password);

    if (!user) {
      const ip = req.headers.get('x-forwarded-for') || 'unknown';
      await addLog('System Security', 'Login ล้มเหลว', `username: "${username}" | IP: ${ip}`);
      return NextResponse.json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (Invalid username or password)' }, { status: 400 });
    }

    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, {
      user,
      expires: Date.now() + SESSION_EXPIRY_MS,
    });

    await addLog(user.username, 'เข้าสู่ระบบ', 'ล็อกอินเข้าสู่หน้าจัดการสำเร็จ');

    const res = NextResponse.json({ token, user });
    res.cookies.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 86400,
      path: '/',
    });

    return res;
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
