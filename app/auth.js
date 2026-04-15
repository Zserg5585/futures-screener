/**
 * Auth UI — Login/Register/Google, JWT token management, user state
 */
const authUI = (() => {
  // --- State ---
  let currentUser = null
  let token = localStorage.getItem('fs_token') || null

  // --- DOM refs ---
  const authBtn = document.getElementById('authBtn')
  const authModal = document.getElementById('authModal')
  const authModalClose = document.getElementById('authModalClose')
  const authOverlay = authModal.querySelector('.auth-modal-overlay')
  const authError = document.getElementById('authError')
  const loginForm = document.getElementById('loginForm')
  const registerForm = document.getElementById('registerForm')
  const authTabs = authModal.querySelectorAll('.auth-tab')
  const googleAuthBtn = document.getElementById('googleAuthBtn')

  // --- API helper ---
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(path, { ...opts, headers })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Request failed')
    return data
  }

  // Expose for other modules
  function getToken() { return token }
  function getUser() { return currentUser }
  function isLoggedIn() { return !!currentUser }
  function isPro() { return currentUser && (currentUser.tier === 'pro' || currentUser.tier === 'admin') }

  // --- Auth-aware fetch wrapper (used by other modules) ---
  function authFetch(url, opts = {}) {
    const headers = { ...opts.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(url, { ...opts, headers })
  }

  // --- UI Updates ---
  function updateAuthButton() {
    if (currentUser) {
      const initial = (currentUser.name || currentUser.email)[0].toUpperCase()
      const tierBadge = currentUser.tier === 'pro' ? ' PRO' : currentUser.tier === 'admin' ? ' ADM' : ''
      authBtn.innerHTML = `<span class="auth-avatar">${initial}</span>${tierBadge ? `<span class="auth-tier-badge ${currentUser.tier}">${tierBadge}</span>` : ''}`
      authBtn.title = `${currentUser.name || currentUser.email} (${currentUser.tier})`
      authBtn.classList.add('logged-in')
    } else {
      authBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
      authBtn.title = 'Login / Register'
      authBtn.classList.remove('logged-in')
    }
  }

  function showError(msg) {
    authError.textContent = msg
    authError.classList.remove('hidden')
    setTimeout(() => authError.classList.add('hidden'), 5000)
  }

  function openModal() {
    authModal.classList.remove('hidden')
    if (currentUser) {
      // Show profile/logout instead of login
      showProfile()
    } else {
      loginForm.classList.remove('hidden')
      registerForm.classList.add('hidden')
      authTabs[0].classList.add('active')
      authTabs[1].classList.remove('active')
    }
  }

  function closeModal() {
    authModal.classList.add('hidden')
    authError.classList.add('hidden')
  }

  function showProfile() {
    // Replace forms with profile view
    const box = authModal.querySelector('.auth-modal-box')
    const existingProfile = box.querySelector('.auth-profile')
    if (existingProfile) existingProfile.remove()

    const profileHtml = document.createElement('div')
    profileHtml.className = 'auth-profile'
    profileHtml.innerHTML = `
      <div class="auth-profile-info">
        <div class="auth-profile-avatar">${(currentUser.name || currentUser.email)[0].toUpperCase()}</div>
        <div class="auth-profile-details">
          <div class="auth-profile-name">${currentUser.name || 'User'}</div>
          <div class="auth-profile-email">${currentUser.email}</div>
          <div class="auth-profile-tier">Plan: <span class="${currentUser.tier}">${currentUser.tier.toUpperCase()}</span></div>
        </div>
      </div>
      <button class="auth-logout-btn" id="logoutBtn">Logout</button>
    `
    // Hide forms, tabs, divider, google
    loginForm.classList.add('hidden')
    registerForm.classList.add('hidden')
    authModal.querySelector('.auth-modal-tabs').classList.add('hidden')
    authModal.querySelector('.auth-divider').classList.add('hidden')
    googleAuthBtn.classList.add('hidden')

    box.insertBefore(profileHtml, authModal.querySelector('.auth-divider'))

    profileHtml.querySelector('#logoutBtn').addEventListener('click', () => {
      logout()
      closeModal()
    })
  }

  // --- Auth Actions ---
  async function tryAutoLogin() {
    if (!token) return
    try {
      const data = await api('/api/auth/me')
      currentUser = data.user
      updateAuthButton()
      console.log('[Auth] Auto-login:', currentUser.email, currentUser.tier)
    } catch (e) {
      // Token expired/invalid
      token = null
      localStorage.removeItem('fs_token')
      console.log('[Auth] Token expired, cleared')
    }
  }

  function saveToken(t) {
    token = t
    localStorage.setItem('fs_token', t)
  }

  function logout() {
    token = null
    currentUser = null
    localStorage.removeItem('fs_token')
    updateAuthButton()
    // Restore modal to login state
    const profile = authModal.querySelector('.auth-profile')
    if (profile) profile.remove()
    authModal.querySelector('.auth-modal-tabs').classList.remove('hidden')
    authModal.querySelector('.auth-divider').classList.remove('hidden')
    googleAuthBtn.classList.remove('hidden')
    console.log('[Auth] Logged out')
  }

  // --- Event Listeners ---
  authBtn.addEventListener('click', openModal)
  authModalClose.addEventListener('click', closeModal)
  authOverlay.addEventListener('click', closeModal)

  // Tab switching
  authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.authTab
      authTabs.forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      loginForm.classList.toggle('hidden', target !== 'login')
      registerForm.classList.toggle('hidden', target !== 'register')
      authError.classList.add('hidden')
    })
  })

  // Login
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = document.getElementById('loginEmail').value.trim()
    const password = document.getElementById('loginPassword').value
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      })
      saveToken(data.token)
      currentUser = data.user
      updateAuthButton()
      closeModal()
      loginForm.reset()
    } catch (err) {
      showError(err.message)
    }
  })

  // Register
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = document.getElementById('regName').value.trim()
    const email = document.getElementById('regEmail').value.trim()
    const password = document.getElementById('regPassword').value
    const confirm = document.getElementById('regConfirm').value

    if (password !== confirm) {
      showError('Passwords do not match')
      return
    }

    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name })
      })
      saveToken(data.token)
      currentUser = data.user
      updateAuthButton()
      closeModal()
      registerForm.reset()
    } catch (err) {
      showError(err.message)
    }
  })

  // Google OAuth
  googleAuthBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/auth/google/url')
      if (data.url) {
        window.location.href = data.url
      } else {
        showError('Google OAuth not configured yet')
      }
    } catch (err) {
      showError('Google OAuth not available')
    }
  })

  // Handle Google OAuth callback (if redirected back with ?code=)
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.has('code')) {
    const code = urlParams.get('code')
    api('/api/auth/google/callback', {
      method: 'POST',
      body: JSON.stringify({ code })
    }).then(data => {
      saveToken(data.token)
      currentUser = data.user
      updateAuthButton()
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname)
    }).catch(err => {
      console.error('[Auth] Google callback error:', err)
    })
  }

  // Keyboard: Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !authModal.classList.contains('hidden')) {
      closeModal()
    }
  })

  // --- Init ---
  tryAutoLogin()

  // --- Tier Gating ---
  // Shows PRO badge on locked features. In dev mode everything is unlocked.
  // Set authUI.prodMode = true before launch to enforce gates.
  let prodMode = false

  /**
   * Check if feature is available. If not, shows login or upgrade prompt.
   * @param {string} feature - feature name for logging
   * @param {boolean} requiresPro - true if PRO only
   * @returns {boolean} true if allowed
   */
  function gateCheck(feature, requiresPro = false) {
    // Dev mode: everything unlocked
    if (!prodMode) return true

    if (requiresPro && !isPro()) {
      if (!isLoggedIn()) {
        openModal()
      } else {
        // Show upgrade prompt
        showUpgradeHint(feature)
      }
      return false
    }
    return true
  }

  function showUpgradeHint(feature) {
    const existing = document.querySelector('.pro-upgrade-toast')
    if (existing) existing.remove()

    const toast = document.createElement('div')
    toast.className = 'pro-upgrade-toast'
    toast.innerHTML = `🔒 <b>${feature}</b> requires PRO plan`
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }

  // --- Public API ---
  return {
    getToken,
    getUser,
    isLoggedIn,
    isPro,
    authFetch,
    openModal,
    logout,
    gateCheck,
    get prodMode() { return prodMode },
    set prodMode(v) { prodMode = v },
  }
})()
