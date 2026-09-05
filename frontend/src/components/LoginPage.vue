<script setup>
import { ref } from 'vue';
import { apiFetch, setSession } from '../api.js';

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

const emit = defineEmits(['logged-in']);

async function submit() {
    if (busy.value) return;
    error.value = '';
    busy.value = true;
    try {
        // ใช้ POST /api/auth/login ตัวเดียวกับหน้าเดิม — คืน { token, user }
        // แล้วเก็บลง localStorage คีย์เดิม ('token' / 'user') เพื่อให้สอง UI
        // ใช้ session ร่วมกันได้ระหว่างช่วงย้ายระบบ
        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: username.value, password: password.value })
        });
        if (!res.token) throw new Error('เข้าสู่ระบบไม่สำเร็จ');
        setSession(res.token, res.user);
        password.value = '';
        emit('logged-in');
    } catch (err) {
        error.value = err.message;
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <div class="v2-login">
        <form class="v2-login-card" @submit.prevent="submit">
            <div class="v2-login-brand">
                <i class="fa-solid fa-diagram-project"></i>
                <div>
                    <strong>MT Management</strong>
                    <span class="v2-pilot-tag">v2</span>
                </div>
            </div>
            <p class="v2-login-sub">เข้าสู่ระบบเพื่อจัดการเราท์เตอร์ MikroTik</p>

            <label class="v2-field">
                <span>ชื่อผู้ใช้ (Username)</span>
                <input
                    v-model="username"
                    type="text"
                    class="form-control"
                    autocomplete="username"
                    placeholder="กรอกชื่อผู้ใช้"
                    required
                    autofocus
                >
            </label>

            <label class="v2-field">
                <span>รหัสผ่าน (Password)</span>
                <input
                    v-model="password"
                    type="password"
                    class="form-control"
                    autocomplete="current-password"
                    placeholder="กรอกรหัสผ่าน"
                    required
                >
            </label>

            <p v-if="error" class="v2-login-error">
                <i class="fa-solid fa-circle-exclamation"></i> {{ error }}
            </p>

            <button type="submit" class="btn btn-primary btn-block" :disabled="busy">
                <i class="fa-solid" :class="busy ? 'fa-spinner fa-spin' : 'fa-arrow-right-to-bracket'"></i>
                {{ busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ' }}
            </button>

            <a class="v2-login-back" href="/v1/">← กลับไปหน้าเดิม</a>
        </form>
    </div>
</template>

<style scoped>
.v2-login {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.v2-login-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    padding: 32px;
    width: 100%;
    max-width: 400px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.v2-login-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #1e293b;
    font-size: 1.05rem;
}

.v2-login-brand i {
    color: #2563eb;
    font-size: 1.3rem;
}

.v2-pilot-tag {
    display: inline-block;
    margin-left: 8px;
    font-size: 0.68rem;
    font-weight: 700;
    background: #e0f2fe;
    color: #0369a1;
    padding: 2px 8px;
    border-radius: 10px;
    vertical-align: middle;
}

.v2-login-sub {
    margin: -8px 0 4px;
    font-size: 0.85rem;
    color: #64748b;
}

.v2-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.v2-field span {
    font-size: 0.82rem;
    font-weight: 600;
    color: #334155;
}

.v2-login-error {
    margin: 0;
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 0.82rem;
}

.v2-login-back {
    text-align: center;
    font-size: 0.8rem;
    color: #64748b;
    text-decoration: none;
}

.v2-login-back:hover {
    color: #2563eb;
}
</style>
