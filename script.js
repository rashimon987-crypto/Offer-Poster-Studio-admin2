const SUPABASE_URL = 'https://peftmuasykbcrhtkhhjf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZnRtdWFzeWtiY3JodGtoaGpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MzkzMTIsImV4cCI6MjEwMTMxNTMxMn0.oiFn_41F-jBxK8tizA3qPoC1UPJPC72SvNxyxiUlhGY';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== Google Sign-In =====
// The "Continue with Google" button below uses Supabase's built-in OAuth redirect flow
// (sb.auth.signInWithOAuth). With this flow, the Google Client ID/Secret are configured
// ONCE in your Supabase project dashboard — NOT here in the HTML:
//   Supabase Dashboard → Authentication → Providers → Google → paste your Client ID
//   and Client Secret from Google Cloud Console, then Save.
// You do NOT need to edit this file for that to work.
//
// GOOGLE_CLIENT_ID below is ONLY used if you later add the native Google "Sign in with
// Google" button / One Tap widget (google.accounts.id.initialize) instead of the redirect
// flow — paste your OAuth Client ID from https://console.cloud.google.com/apis/credentials
// here if you do that. Leave the placeholder as-is otherwise; it is not required.
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

// ===== Razorpay =====
// Paste your Razorpay Key ID (starts with rzp_test_ or rzp_live_) from
// https://dashboard.razorpay.com/app/keys — this "Key ID" is public and safe to put in
// client-side code, same as it would appear in Razorpay's own checkout examples.
//
// ⚠️ Your Razorpay Key SECRET must NEVER go in this file or any other client-side code —
// it is not needed for the checkout flow used here (see activatePlanAfterPayment below for
// the automatic-activation tradeoff this implies).
const RAZORPAY_KEY_ID = 'rzp_test_YOUR_KEY_ID';

async function authSignUp(email, password, shopName) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { data: { shop_name: shopName || 'My Shop' } } });
  if (error) throw error;
  return data;
}
async function authSignIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
async function authSignOut() { await sb.auth.signOut(); }
async function authSendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) throw error;
}
// Redirects to Google's sign-in page and back — Supabase exchanges the result for a
// session automatically, so boot() picks it up on the next load exactly like an email
// login. Requires the Google provider to be enabled in the Supabase dashboard (see the
// GOOGLE_CLIENT_ID comment above).
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
  if (error) toast(error.message, true);
}
function toggleEmailAuthForm() {
  const form = document.getElementById('emailAuthForm');
  const link = document.getElementById('emailToggleLink');
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : 'block';
  link.textContent = showing ? 'Sign in with email instead' : 'Hide email sign-in';
}
async function getCurrentUser() { const { data } = await sb.auth.getUser(); return data?.user || null; }
async function getCurrentProfile() {
  const user = await getCurrentUser(); if (!user) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) {
    if (error.code !== 'PGRST116') console.error(error);
    return null;
  }
  return data;
}
// Email signup passes shop_name as user metadata, which a Supabase trigger normally turns
// into a profiles row. Google sign-in has no such step, so a first-time Google user would
// otherwise be stuck authenticated-but-profile-less. This creates a minimal profile row
// on the fly using whatever Google gave us, so Google sign-in works without any database
// changes on your end.
async function ensureProfileExists(user) {
  const shopName = user.user_metadata?.full_name || user.user_metadata?.name || (user.email ? user.email.split('@')[0] : 'My Shop');
  const { data, error } = await sb.from('profiles').insert({ id: user.id, email: user.email, shop_name: shopName, plan: 'free' }).select().single();
  if (error) { console.error('Could not auto-create profile:', error); return null; }
  return data;
}

async function uploadFile(bucket, file, pathPrefix) {
  const ext = file.name.split('.').pop();
  const path = `${pathPrefix ? pathPrefix + '/' : ''}${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.background = isError ? '#C4402A' : '#132420';
  t.classList.add('show'); clearTimeout(window._toastT);
  window._toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
function fmtDate(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
function fmtMoney(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : 'id_' + Math.random().toString(36).slice(2); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

let STATE = {
  user: null, profile: null, currentScreen: 'auth', authMode: 'login',
  marketplaceCat: 'all', marketplaceTag: 'all', dashTab: 'all',
  templates: [], categories: [], stickers: [], products: [], settings: {}, favorites: [],
  editor: null
};

// ===== View mode (mobile app layout vs desktop site layout) =====
// desktopOverride: null = auto (follow real window width), true = forced desktop,
// false = forced mobile. The toggle button lets you preview the desktop design on a
// phone (or the mobile design on a desktop) regardless of your actual screen width —
// auto-detection alone isn't enough since phones can't just "become" 1280px wide.
let desktopOverride = null;
const DESKTOP_BREAKPOINT = 900;
function isDesktopViewActive() {
  return desktopOverride === null ? window.innerWidth >= DESKTOP_BREAKPOINT : desktopOverride;
}
function applyViewMode() {
  const desktop = isDesktopViewActive();
  document.body.classList.toggle('desktop-view', desktop);
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    if (desktopOverride === true && window.innerWidth < DESKTOP_BREAKPOINT) {
      // Forcing desktop layout on a physically narrow screen: widen the virtual
      // viewport so the full desktop design is visible (pinch-zoom/scroll to see it),
      // the same trick browsers use for "Request Desktop Site".
      meta.setAttribute('content', 'width=1280');
    } else {
      meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
    }
  }
  const btn = document.getElementById('viewModeToggle');
  if (btn) btn.textContent = desktop ? '📱 Mobile View' : '🖥️ Desktop View';
}
function toggleDesktopView() {
  desktopOverride = !isDesktopViewActive();
  applyViewMode();
}
window.addEventListener('resize', () => { if (desktopOverride === null) applyViewMode(); });
applyViewMode();

async function boot() {
  const user = await getCurrentUser();
  if (!user) { showLanding(); return; }
  try { await sb.rpc('expire_plans'); } catch (e) { /* non-fatal */ }
  let profile = await getCurrentProfile();
  if (!profile) { profile = await ensureProfileExists(user); }
  if (!profile) { showAuth(); return; }
  if (profile.suspended) {
    toast('Your account has been suspended. Contact support.', true);
    await authSignOut(); showAuth(); return;
  }
  STATE.user = user; STATE.profile = profile;
  expireLocalPlan();
  await loadSharedData();
  enterApp();
}
async function loadSharedData() {
  const [cats, tpls, stickers, products, settingsRow, favs] = await Promise.all([
    sb.from('categories').select('*').order('label'),
    sb.from('templates').select('*').eq('enabled', true).order('created_at', { ascending: false }),
    sb.from('store_assets').select('*').eq('enabled', true).in('type', ['sticker', 'badge', 'festival_decoration', 'offer_label', 'price_tag']),
    sb.from('products').select('*').order('created_at', { ascending: false }),
    sb.from('settings').select('*').eq('id', 1).single(),
    sb.from('favorites').select('template_id').eq('user_id', STATE.user.id)
  ]);
  STATE.categories = cats.data || [];
  STATE.templates = tpls.data || [];
  STATE.stickers = stickers.data || [];
  STATE.products = products.data || [];
  STATE.settings = settingsRow.data || {};
  try { // plans are managed in Admin → Plans; if the table is missing/empty the built-in plans below are used
    const pr = await sb.from('plans').select('*').eq('active', true).order('sort');
    if (!pr.error && pr.data && pr.data.length) {
      PLAN_DURATIONS.length = 0;
      pr.data.forEach(r => PLAN_DURATIONS.push({ id: r.id, label: r.name, months: r.months || 1, price: Number(r.price), note: r.note || '', badge: !!r.badge, download_limit: r.download_limit, video_limit: r.video_limit }));
    } else {
      PLAN_DURATIONS.forEach(d => { const v = Number(STATE.settings['price_' + d.id]); if (v > 0) d.price = v; });
    }
  } catch (e) { /* plans stay as coded */ }
  STATE.favorites = (favs.data || []).map(f => f.template_id);

  if (!STATE.settings.demo_templates_seeded) {
    try {
      await sb.rpc('ensure_seed_templates');
      const [retryTpls, retrySettings] = await Promise.all([
        sb.from('templates').select('*').eq('enabled', true).order('created_at', { ascending: false }),
        sb.from('settings').select('*').eq('id', 1).single()
      ]);
      STATE.templates = retryTpls.data || [];
      STATE.settings = retrySettings.data || STATE.settings;
    } catch (e) { console.warn('Auto-seed skipped:', e.message); }
  }
}
function showAuth() {
  document.getElementById('screen-landing').classList.remove('active');
  document.getElementById('screen-auth').classList.add('active');
  document.getElementById('mainShell').style.display = 'none';
  document.getElementById('bottomNav').style.display = 'none';
  renderNavCta();
}
function showLanding() {
  document.getElementById('screen-auth').classList.remove('active');
  document.getElementById('screen-landing').classList.add('active');
  document.getElementById('mainShell').style.display = 'none';
  document.getElementById('bottomNav').style.display = 'none';
  renderFeaturesGrid('landingFeaturesGrid');
  renderLandingCategories('landingCatGrid');
  renderFestivalCategories('landingFestivalGrid');
  renderPricingCards('landingPricingGrid', { mode: 'landing' });
  renderSiteFooter('landingFooter');
  renderNavCta();
}
function enterApp() {
  document.getElementById('screen-auth').classList.remove('active');
  document.getElementById('screen-landing').classList.remove('active');
  document.getElementById('mainShell').style.display = 'block';
  document.getElementById('bottomNav').style.display = 'flex';
  document.getElementById('avatarChip').textContent = (STATE.profile.shop_name || 'U').charAt(0).toUpperCase();
  renderNavCta();
  goto('home');
}

// ===== Desktop navbar + marketing sections (additive; used by screen-landing and,
// for logged-in desktop visitors, appended to the bottom of screen-home) =====
function renderNavCta() {
  const el = document.getElementById('navCtaArea'); if (!el) return;
  if (STATE.user && STATE.profile) {
    el.innerHTML = `<button class="btn btn-outline btn-sm" onclick="goto('dashboard')">👤 ${escapeHtml(STATE.profile.shop_name || 'Profile')}</button>
      <button class="btn btn-primary btn-sm" onclick="handleNavCreate()">Create Poster</button>`;
  } else {
    el.innerHTML = `<button class="btn btn-outline btn-sm" onclick="showAuth();setAuthMode('login')">Login</button>
      <button class="btn btn-primary btn-sm" onclick="showAuth();setAuthMode('signup')">Get Started</button>`;
  }
}
function handleNavHome() { if (STATE.user) { goto('home'); } else { showLanding(); } }
function handleNavTemplates() { if (STATE.user) { goto('marketplace'); } else { showPublicScreen('templates'); } }
function handleNavCreate() { if (STATE.user) { startBlankPoster(); } else { showAuth(); setAuthMode('signup'); } }
function handleNavFeatures() { showPublicScreen('features'); }
function handleNavPricing() { showPublicScreen('pricing'); }
function handleNavContact() { showPublicScreen('contact'); }
function scrollToSection(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ===== In-file "pages": Templates / Features / Pricing / Contact / Privacy / Terms.
// These behave like real separate pages (their own screen, own scroll position, a Back
// button, and a URL hash you can share/bookmark) but never leave this one HTML file. =====
const PUBLIC_SCREENS = ['templates', 'features', 'pricing', 'contact', 'privacy', 'terms'];
let screenBeforePublic = null;
function showPublicScreen(name) {
  if (!PUBLIC_SCREENS.includes(name)) return;
  if (STATE.currentScreen && STATE.currentScreen !== 'pub') screenBeforePublic = { user: !!STATE.user, screen: STATE.currentScreen };
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-pub-' + name).classList.add('active');
  document.getElementById('mainShell').style.display = 'none';
  document.getElementById('bottomNav').style.display = 'none';
  STATE.currentScreen = 'pub';
  window.scrollTo(0, 0);
  history.replaceState(null, '', '#' + name);
  if (name === 'templates') { renderLandingCategories('pubTemplatesGrid'); renderFestivalCategories('pubFestivalGrid'); renderSiteFooter('pubTemplatesFooter'); }
  if (name === 'features') { renderFeaturesGrid('pubFeaturesGrid'); renderSiteFooter('pubFeaturesFooter'); }
  if (name === 'pricing') { renderPricingCards('pubPricingGrid', { mode: STATE.user ? 'home' : 'landing' }); renderSiteFooter('pubPricingFooter'); }
  if (name === 'contact') { renderSiteFooter('pubContactFooter'); }
  if (name === 'privacy') { renderSiteFooter('pubPrivacyFooter'); }
  if (name === 'terms') { renderSiteFooter('pubTermsFooter'); }
}
function closePublicScreen() {
  history.replaceState(null, '', location.pathname);
  if (STATE.user) {
    document.getElementById('mainShell').style.display = 'block';
    goto((screenBeforePublic && screenBeforePublic.user) ? screenBeforePublic.screen : 'home');
  } else {
    showLanding();
  }
}

const MARKETING_FEATURES = [
  { ic: '🖼️', title: 'Poster Maker', desc: 'Design offer posters visually — no design skill needed.' },
  { ic: '🎨', title: 'Ready Templates', desc: 'Dozens of ready-made layouts for every occasion.' },
  { ic: '🛒', title: 'Supermarket Offers', desc: 'Built for grocery, supermarket & retail price tags.' },
  { ic: '📱', title: 'WhatsApp Sharing', desc: 'Export and share straight to WhatsApp status or groups.' },
  { ic: '📸', title: 'Multiple Photos', desc: 'Add multiple product photos in one clean layout.' },
  { ic: '✨', title: 'Premium Designs', desc: 'Unlock premium templates and festival specials.' },
  { ic: '⬇️', title: 'High Quality Download', desc: 'Export sharp, high-resolution PNG or JPG posters.' },
  { ic: '📲', title: 'Social Media Ready', desc: 'Perfectly sized for Instagram, Facebook & Status.' }
];
function renderFeaturesGrid(containerId) {
  const el = document.getElementById(containerId); if (!el) return;
  el.innerHTML = MARKETING_FEATURES.map(f => `
    <div class="feature-card"><div class="fic">${f.ic}</div><h3>${escapeHtml(f.title)}</h3><p>${escapeHtml(f.desc)}</p></div>
  `).join('');
}

const MARKETING_CATEGORIES = [
  { icon: '1️⃣', label: '1 Photo' }, { icon: '2️⃣', label: '2 Photos' }, { icon: '4️⃣', label: '4 Photos' },
  { icon: '6️⃣', label: '6 Photos' }, { icon: '9️⃣', label: '9 Photos' }, { icon: '🔟', label: '12 Photos' },
  { icon: '🛒', label: 'Supermarket' }, { icon: '🎉', label: 'Festival' }, { icon: '🍔', label: 'Food' },
  { icon: '📱', label: 'Electronics' }, { icon: '👗', label: 'Fashion' },
  { icon: '🥦', label: 'Grocery' }, { icon: '🍽️', label: 'Restaurant' }, { icon: '🍞', label: 'Bakery' },
  { icon: '☕', label: 'Cafe' }, { icon: '👕', label: 'Clothing' }, { icon: '💍', label: 'Jewellery' },
  { icon: '📲', label: 'Mobile Shop' }, { icon: '🛋️', label: 'Furniture' }, { icon: '🏠', label: 'Interior' },
  { icon: '👟', label: 'Footwear' }, { icon: '💄', label: 'Cosmetics' }, { icon: '💇', label: 'Beauty Salon' },
  { icon: '🏨', label: 'Hotel' }, { icon: '💊', label: 'Pharmacy' }, { icon: '🔧', label: 'Hardware' },
  { icon: '🧺', label: 'Home Appliances' }, { icon: '🚗', label: 'Automobile' }, { icon: '🏘️', label: 'Real Estate' },
  { icon: '🏸', label: 'Sports Shop' }, { icon: '✏️', label: 'Stationery' }, { icon: '🎁', label: 'Gift Shop' }
];
function renderLandingCategories(containerId) {
  const el = document.getElementById(containerId); if (!el) return;
  el.innerHTML = MARKETING_CATEGORIES.map(c => `
    <div class="cat-tile" onclick="showAuth();setAuthMode('signup')"><div class="ic">${c.icon}</div><span>${escapeHtml(c.label)}</span></div>
  `).join('');
}
const FESTIVAL_CATEGORIES = [
  { icon: '🪔', label: 'Diwali' }, { icon: '🎨', label: 'Holi' }, { icon: '🌙', label: 'Eid' },
  { icon: '🎄', label: 'Christmas' }, { icon: '🌾', label: 'Onam' }, { icon: '🌿', label: 'Vishu' },
  { icon: '🌻', label: 'Pongal' }, { icon: '🐘', label: 'Ganesh Chaturthi' }, { icon: '🪅', label: 'Navratri' },
  { icon: '🏹', label: 'Dussehra' }, { icon: '🎗️', label: 'Raksha Bandhan' }, { icon: '🇮🇳', label: 'Independence Day' },
  { icon: '🇮🇳', label: 'Republic Day' }, { icon: '🎊', label: 'New Year' }, { icon: '☀️', label: 'Summer Sale' },
  { icon: '🌧️', label: 'Monsoon Sale' }, { icon: '🏷️', label: 'Clearance Sale' }, { icon: '🎉', label: 'Grand Opening' },
  { icon: '📅', label: 'Weekend Sale' }, { icon: '✨', label: 'Festive Sale' }
];
function renderFestivalCategories(containerId) {
  const el = document.getElementById(containerId); if (!el) return;
  el.innerHTML = FESTIVAL_CATEGORIES.map(c => `
    <div class="cat-tile" onclick="showAuth();setAuthMode('signup')"><div class="ic">${c.icon}</div><span>${escapeHtml(c.label)}</span></div>
  `).join('');
}

function renderPricingCards(containerId, opts) {
  const el = document.getElementById(containerId); if (!el) return;
  const mode = (opts && opts.mode) || 'landing';
  const freeLimit = (STATE.settings && STATE.settings.free_download_limit) ?? 1;
  const ctaFor = (plan) => mode === 'home'
    ? `onclick="goto('payment')"`
    : `onclick="showAuth();setAuthMode('signup')"`;
  const dlText = d => d.download_limit ? `${d.download_limit} downloads` : 'Unlimited downloads';
  const plans = [
    { name: 'Free', price: '₹0', suffix: '', features: [`${freeLimit} download/day`, 'Basic templates', 'Watermark on export'], cta: 'Get Started', featured: false },
  ].concat(PLAN_DURATIONS.map(d => ({ name: d.label, price: fmtMoney(d.price), suffix: '', features: [dlText(d), ...(d.video_limit ? [`${d.video_limit} videos`] : []), 'All premium templates', 'No watermark', 'HD export'], cta: 'Choose ' + d.label, featured: !!d.badge })));
  el.innerHTML = plans.map(p => `
    <div class="pricing-card ${p.featured ? 'featured' : ''}">
      <div class="pname">${p.name}</div>
      <div class="pprice">${p.price}<span>${p.suffix}</span></div>
      <ul>${p.features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
      <button class="btn ${p.featured ? 'btn-gold' : 'btn-outline'} btn-block" ${ctaFor(p.name)}>${p.cta}</button>
    </div>
  `).join('');
}

function renderSiteFooter(containerId) {
  const el = document.getElementById(containerId); if (!el) return;
  el.innerHTML = `
    <div class="foot-inner">
      <div style="max-width:340px;">
        <h4>Offer Poster Studio</h4>
        <p class="tagline">Professional promotional poster maker for businesses.</p>
      </div>
      <div class="foot-links">
        <a onclick="handleNavHome()">Home</a>
        <a onclick="handleNavTemplates()">Templates</a>
        <a onclick="handleNavPricing()">Pricing</a>
        <a onclick="handleNavFeatures()">Features</a>
        <a onclick="handleNavContact()">Contact</a>
        <a onclick="showPublicScreen('privacy')">Privacy Policy</a>
        <a onclick="showPublicScreen('terms')">Terms &amp; Conditions</a>
      </div>
    </div>
    <div class="foot-bottom">© ${new Date().getFullYear()} Offer Poster Studio · www.offerposterstudio.in</div>
  `;
}

function setAuthMode(mode) {
  STATE.authMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabSignup').classList.toggle('active', mode === 'signup');
  document.getElementById('signupExtra').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('authTitle').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
  document.getElementById('authSub').textContent = mode === 'login' ? 'Sign in to keep making posters that sell.' : 'Start creating professional posters in minutes.';
  document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Log In' : 'Create Account';
  document.getElementById('authSwitchText').innerHTML = mode === 'login'
    ? `New here? <a href="#" onclick="setAuthMode('signup');return false;">Create an account</a>`
    : `Already have an account? <a href="#" onclick="setAuthMode('login');return false;">Log in</a>`;
  document.getElementById('authError').style.display = 'none';
}
async function submitAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPassword').value;
  const err = document.getElementById('authError'); err.style.display = 'none';
  if (!email || !pw) { err.textContent = 'Please fill in email and password.'; err.style.display = 'block'; return; }
  try {
    if (STATE.authMode === 'signup') {
      const shop = document.getElementById('signupShop').value.trim() || 'My Shop';
      await authSignUp(email, pw, shop);
      toast('Account created! Check your email if confirmation is required, then log in.');
      setAuthMode('login');
    } else {
      await authSignIn(email, pw);
      await boot();
    }
  } catch (e) {
    err.textContent = e.message || 'Something went wrong.'; err.style.display = 'block';
  }
}
function openForgot() { openSheet('sheetForgot'); }
async function submitForgot() {
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) { toast('Enter your email', true); return; }
  try {
    await authSendPasswordReset(email);
    document.getElementById('forgotMsg').style.display = 'block';
    document.getElementById('forgotMsg').textContent = 'Reset link sent — check your inbox.';
  } catch (e) { toast(e.message, true); }
}
async function logout() { await authSignOut(); window.location.reload(); }

function goto(screen) {
  STATE.currentScreen = screen;
  document.querySelectorAll('#mainShell .screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + screen).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navMap = { home: 'home', marketplace: 'marketplace', dashboard: 'dashboard', profile: 'profile' };
  document.querySelectorAll(`.nav-item[data-nav="${navMap[screen] || screen}"]`).forEach(n => n.classList.add('active'));
  document.getElementById('bottomNav').style.display = (screen === 'editor' || screen === 'studio') ? 'none' : 'flex';
  window.scrollTo(0, 0);
  if (screen === 'home') renderHome();
  if (screen === 'marketplace') renderMarketplace();
  if (screen === 'dashboard') renderDashboard();
  if (screen === 'profile') renderProfile();
  if (screen === 'payment') renderPayment();
  if (screen === 'library') renderLibraryGallery();
  // Design Studio is a separate module (studio.js); it boots itself lazily on first visit
  // so it never runs (and Fabric.js never initializes) for people who only use the poster editor.
  if (screen === 'studio' && window.Studio) Studio.enterScreen();
}
function exitStudio() { if (window.Studio) Studio.onExit(); goto('home'); }
function openSheet(id) { document.getElementById('overlay').classList.add('show'); document.getElementById(id).classList.add('show'); }
function closeSheets() { document.getElementById('overlay').classList.remove('show'); document.querySelectorAll('.sheet').forEach(s => s.classList.remove('show')); }

function isPremiumLocked(t) { return !!t.premium && STATE.profile.plan === 'free'; }
function tplCard(t) {
  const catLabel = STATE.categories.find(c => c.id === t.category_id)?.label || t.category_id;
  const badge = t.festival || catLabel;
  const isFav = STATE.favorites.includes(t.id);
  const locked = isPremiumLocked(t);
  const openAction = locked ? `goto('payment')` : `openTemplate('${t.id}')`;
  return `<div class="tcard" onclick="${openAction}">
    <div class="thumb" style="background-image:url('${t.thumb_url || ''}')">
      <span class="badge">${escapeHtml(badge)}</span>
      <button class="fav" onclick="event.stopPropagation();toggleFavorite('${t.id}')">${isFav ? '❤️' : '🤍'}</button>
      <div class="tlabel">${escapeHtml(t.title)}</div>
      ${locked ? `<div class="lockbadge">🔒<span style="font-size:10px;font-weight:800;">PREMIUM</span></div>` : ''}
    </div>
    <div class="meta"><div class="cat">${escapeHtml(catLabel)}</div>
      <button class="use-btn" onclick="event.stopPropagation();${locked ? "goto('payment')" : `openTemplate('${t.id}')`}">${locked ? '🔓 Unlock' : 'Use Template'}</button>
    </div></div>`;
}

function setEditorTab(tab) {
  document.querySelectorAll('.etab').forEach(e => e.classList.toggle('active', e.dataset.tab === tab));
  document.querySelectorAll('.panel-block').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  if (tab === 'style') { renderColorSwatches(); renderTextColorSwatches(); renderPillColorSwatches(); renderProductColorSwatches(); renderBorderlessToggle(); }
  if (tab === 'headertpl') { renderHeaderTplLibrary(); }
  if (tab === 'text') { renderTextControls(); renderTextLayerChips(); }
  if (tab === 'elements') { renderShapeLibrary(); renderElementControls(); }
}

// All solid, single-tone colors on purpose — no gradients or 2-color mixes here, since this
// swatch row sets a flat fill for text (headline/shop-name/footer), unlike the background
// THEME_COLORS/GRADIENT_PRESETS row above.
const TEXT_COLORS = [
  '#152420', '#FFFFFF', '#000000', '#5B6E67',
  '#CC9A3C', '#FFD700', '#F59E0B', '#FB923C',
  '#E1553B', '#DC2626', '#F43F5E', '#EC4899',
  '#7C3AED', '#6366F1', '#3B82F6', '#0EA5E9',
  '#0E6E5D', '#10B981', '#14B8A6', '#84CC16',
  '#2E5AAC', '#C4402A', '#8B2500', '#C0C0C0'
];

function renderTextColorSwatches() {
  const row = document.getElementById('textColorSwatches');
  if (!row) return;
  row.innerHTML = TEXT_COLORS.map(c => `
    <div class="swatch ${(STATE.editor.textColor === c) ? 'active' : ''}" style="background:${c}; border: 1.5px solid #cbd5e1;" onclick="setTextTheme('${c}')"></div>
  `).join('');
}

function setTextTheme(c) {
  pushHistory();
  STATE.editor.textColor = c;
  renderTextColorSwatches();
  renderPoster();
}

// "Full Screen (No Border)" — removes the header/footer bands and side border strips so
// the whole canvas is one flat, changeable color/gradient behind the photo and text.
function toggleBorderless() {
  pushHistory();
  STATE.editor.borderless = !STATE.editor.borderless;
  renderBorderlessToggle();
  renderPoster();
}
function renderBorderlessToggle() {
  const btn = document.getElementById('borderlessToggleBtn'); if (!btn || !STATE.editor) return;
  const on = !!STATE.editor.borderless;
  btn.textContent = on ? 'ON' : 'OFF';
  btn.className = 'btn btn-sm ' + (on ? 'btn-gold' : 'btn-outline');
}

// Discount / date pill and product-name caption each get their own independent color,
// separate from the main Text Color above (which only affects shop name / headline / address).
function renderPillColorSwatches() {
  const row = document.getElementById('pillColorSwatches');
  if (!row) return;
  row.innerHTML = TEXT_COLORS.map(c => `
    <div class="swatch ${(STATE.editor.pillTextColor === c) ? 'active' : ''}" style="background:${c}; border: 1.5px solid #cbd5e1;" onclick="setPillTextColor('${c}')"></div>
  `).join('');
}
function setPillTextColor(c) {
  pushHistory();
  STATE.editor.pillTextColor = c;
  renderPillColorSwatches();
  renderPoster();
}
function renderProductColorSwatches() {
  const row = document.getElementById('productColorSwatches');
  if (!row) return;
  row.innerHTML = TEXT_COLORS.map(c => `
    <div class="swatch ${(STATE.editor.productTextColor === c) ? 'active' : ''}" style="background:${c}; border: 1.5px solid #cbd5e1;" onclick="setProductTextColor('${c}')"></div>
  `).join('');
}
function setProductTextColor(c) {
  pushHistory();
  STATE.editor.productTextColor = c;
  renderProductColorSwatches();
  renderPoster();
}
 
function renderHome() {
  renderBoldSaleRow();
  renderSingleProductRow();
  const trending = document.getElementById('trendingRow');
  if (trending) trending.innerHTML = STATE.templates.filter(t => t.trending).slice(0, 10).map(tplCard).join('') || emptyRowMsg('No trending templates yet.');

  const featured = document.getElementById('featuredRow');
  if (featured) featured.innerHTML = STATE.templates.filter(t => t.featured).slice(0, 10).map(tplCard).join('') || emptyRowMsg('No featured templates yet.');

  const premium = document.getElementById('premiumRow');
  if (premium) premium.innerHTML = STATE.templates.filter(t => t.premium).slice(0, 10).map(tplCard).join('') || emptyRowMsg('No premium templates yet.');

  const catTiles = document.getElementById('catTiles');
  if (catTiles) {
    catTiles.innerHTML = STATE.categories.slice(0, 8).map(c => `
      <div class="cat-tile" onclick="goto('marketplace');setMarketCat('${c.id}')"><div class="ic">${c.icon}</div><span>${escapeHtml(c.label)}</span></div>`).join('');
  }

  const libRow = document.getElementById('homeLibraryRow');
  if (libRow) {
    libRow.innerHTML = (STATE.products || []).slice(0, 8).map(p => `
      <div class="tcard" onclick="goto('library')">
        <div class="thumb" style="background-image:url('${p.image_url}')">
          <span class="badge">Free</span>
          <div class="tlabel" style="font-size:12px;">${escapeHtml(p.name)}</div>
        </div>
        <div class="meta"><div class="use-btn" style="text-align:center;">View & Download</div></div>
      </div>
    `).join('') || '<p style="padding:0 18px;color:var(--muted);font-size:13px;">No photos available.</p>';
  }

  // Desktop-only marketing sections appended to the bottom of Home (invisible on mobile —
  // see .desktop-extra-sections in CSS — so the phone app view is unaffected).
  renderFeaturesGrid('homeFeaturesGrid');
  renderPricingCards('homePricingGrid', { mode: 'home' });
  renderSiteFooter('homeFooter');
}

function emptyRowMsg(m) { return `<p style="padding:0 18px;color:var(--muted);font-size:13px;">${m}</p>`; }
function runHomeSearch() {
  const q = document.getElementById('homeSearchInput').value.trim();
  goto('marketplace');
  setTimeout(() => { document.getElementById('searchInput').value = q; renderMarketplace(); }, 0);
}
function setMarketCat(id) { STATE.marketplaceCat = id; renderMarketplace(); }
function setMarketTag(id) { STATE.marketplaceTag = id; renderMarketplace(); }
function renderMarketplace() {
  const cats = [{ id: 'all', label: 'All' }, ...STATE.categories];
  document.getElementById('categoryPills').innerHTML = cats.map(c => `<div class="pill ${STATE.marketplaceCat === c.id ? 'active' : ''}" onclick="setMarketCat('${c.id}')">${escapeHtml(c.label)}</div>`).join('');
  const tags = [{ id: 'all', label: 'All Styles' }, { id: 'flyer', label: '📰 Flyer' }, { id: 'weekly', label: '🗓 Weekly' }, { id: 'festival', label: '🎉 Festival' }, { id: 'premium', label: '👑 Premium' }, { id: 'favorites', label: '❤️ Favorites' }];
  document.getElementById('tagPills').innerHTML = tags.map(t => `<div class="pill ${STATE.marketplaceTag === t.id ? 'active' : ''}" onclick="setMarketTag('${t.id}')">${t.label}</div>`).join('');
  let list = STATE.templates;
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  if (STATE.marketplaceCat !== 'all') list = list.filter(t => t.category_id === STATE.marketplaceCat);
  if (STATE.marketplaceTag === 'premium') list = list.filter(t => t.premium);
  else if (STATE.marketplaceTag === 'favorites') list = list.filter(t => STATE.favorites.includes(t.id));
  else if (STATE.marketplaceTag !== 'all') list = list.filter(t => (t.tags || []).includes(STATE.marketplaceTag) || (STATE.marketplaceTag === 'festival' && t.festival));
  if (q) list = list.filter(t => t.title.toLowerCase().includes(q) || (t.festival || '').toLowerCase().includes(q));
  document.getElementById('marketplaceGrid').innerHTML = list.length ? list.map(tplCard).join('') :
    `<div class="empty-state" style="grid-column:1/-1;"><div class="ic">🔍</div><h3>No templates found</h3><p>Try a different filter.</p></div>`;
}
async function toggleFavorite(templateId) {
  const isFav = STATE.favorites.includes(templateId);
  if (isFav) {
    await sb.from('favorites').delete().eq('user_id', STATE.user.id).eq('template_id', templateId);
    STATE.favorites = STATE.favorites.filter(id => id !== templateId);
    toast('Removed from favorites');
  } else {
    await sb.from('favorites').insert({ user_id: STATE.user.id, template_id: templateId });
    STATE.favorites.push(templateId);
    toast('Added to favorites');
  }
  if (STATE.currentScreen === 'home') renderHome();
  if (STATE.currentScreen === 'marketplace') renderMarketplace();
  if (STATE.currentScreen === 'dashboard') renderDashboard();
}

// A plan ends when plan_expires_at passes: drop to Free (server expire_plans does the same on the next load) and tell the user.
function expireLocalPlan() {
  const p = STATE.profile; if (!p || !p.plan_expires_at) return;
  const ms = new Date(p.plan_expires_at) - new Date();
  if (p.plan !== 'free' && ms <= 0) {
    p.plan = 'free';
    try { sb.from('profiles').update({ plan: 'free' }).eq('id', STATE.user.id).then(() => { }); } catch (e) { /* ignore */ }
    toast('Your plan has expired — you are on the Free plan now. Renew to continue.', true);
  } else if (p.plan !== 'free' && ms < 3 * 86400000) {
    toast('⏰ Your plan expires in ' + Math.max(1, Math.ceil(ms / 86400000)) + ' day(s) — renew to keep unlimited access.', true);
  }
}
function planNoticeHtml() { // banner text for the dashboard
  const p = STATE.profile; if (!p || !p.plan_expires_at) return '';
  const ms = new Date(p.plan_expires_at) - new Date(), d = Math.ceil(ms / 86400000);
  if (p.plan === 'free' && ms <= 0) return '❌ Your plan expired on ' + fmtDate(p.plan_expires_at) + '. You are on the Free plan (1 download + 1 save). Renew to continue.';
  if (p.plan !== 'free' && ms > 0 && d <= 7) return '⏰ Your plan expires in ' + d + ' day' + (d === 1 ? '' : 's') + ' (' + fmtDate(p.plan_expires_at) + '). Renew now so you do not lose access.';
  return '';
}
function planDaysRemaining() {
  if (!STATE.profile.plan_expires_at) return null;
  const diff = new Date(STATE.profile.plan_expires_at) - new Date();
  return Math.max(0, Math.ceil(diff / 86400000));
}
async function renderDashboard() {
  document.getElementById('dashAvatar').textContent = (STATE.profile.shop_name || 'U').charAt(0).toUpperCase();
  document.getElementById('dashName').textContent = STATE.profile.shop_name || 'My Shop';
  document.getElementById('dashEmail').textContent = STATE.profile.email;
  document.getElementById('planName').textContent = STATE.profile.plan === 'free' ? 'Free Plan' : (STATE.profile.plan === 'premium' ? 'Premium Plan ✨' : 'Business Plan 💼');
  const days = planDaysRemaining();
  document.getElementById('planDaysLeft').textContent = days !== null ? days + ' days left' : '';
  document.getElementById('planExpiryRow').textContent = STATE.profile.plan_expires_at ? (STATE.profile.plan === 'free' ? 'Expired ' : 'Expires ') + fmtDate(STATE.profile.plan_expires_at) : 'No active subscription';
  { let nb = document.getElementById('planNotice'); const msg = planNoticeHtml(); const row = document.getElementById('planExpiryRow').parentElement;
    if (!nb && row) { nb = document.createElement('div'); nb.id = 'planNotice'; nb.style.cssText = 'margin-top:10px;padding:10px 12px;border-radius:10px;background:#FEF3C7;color:#92400E;font-weight:700;font-size:13px;line-height:1.4'; row.parentElement.insertBefore(nb, row.nextSibling); }
    if (nb) { nb.textContent = msg; nb.style.display = msg ? 'block' : 'none'; } }
  quotaRemaining('image').then(n => { if (n !== null) document.getElementById('planExpiryRow').textContent += ' · ' + n + ' downloads left'; }).catch(() => { });
  document.getElementById('planUpgradeBtn').style.display = STATE.profile.plan === 'business' ? 'none' : 'inline-flex';

  const [postersRes, downloadsRes] = await Promise.all([
    sb.from('posters').select('*').eq('user_id', STATE.user.id).order('updated_at', { ascending: false }),
    sb.from('downloads_log').select('id').eq('user_id', STATE.user.id)
  ]);
  const posters = postersRes.data || [];
  document.getElementById('statPosters').textContent = posters.length;
  document.getElementById('statDownloads').textContent = (downloadsRes.data || []).length;
  document.getElementById('statFavs').textContent = STATE.favorites.length;

  let list = [];
  if (STATE.dashTab === 'all') {
    list = posters.map(p => ({ id: p.id, title: p.title, thumb: p.thumb_url, kind: 'poster' }));
  } else {
    list = STATE.templates.filter(t => STATE.favorites.includes(t.id)).map(t => ({ id: t.id, title: t.title, thumb: t.thumb_url, kind: 'template' }));
  }
  if (!list.length) {
    document.getElementById('dashGrid').innerHTML = '';
    document.getElementById('dashEmpty').innerHTML = `<div class="empty-state"><div class="ic">🖼️</div><h3>Nothing here yet</h3><p>Start a poster from a template or a blank canvas.</p><button class="btn btn-primary" onclick="goto('marketplace')">Browse Templates</button></div>`;
    return;
  }
  document.getElementById('dashEmpty').innerHTML = '';
  document.getElementById('dashGrid').innerHTML = list.map(item => `
    <div class="poster-item" onclick="${item.kind === 'poster' ? `resumePoster('${item.id}')` : `openTemplate('${item.id}')`}">
      <div class="pv" style="background-image:url('${item.thumb || ''}')"></div>
      <div class="pinfo">${escapeHtml(item.title || 'Untitled')}</div>
    </div>`).join('');
}
function setDashTab(tab) { STATE.dashTab = tab; document.querySelectorAll('.pill[data-tab]').forEach(p => p.classList.toggle('active', p.dataset.tab === tab)); renderDashboard(); }

let profileLogoUrl = null;
function renderProfile() {
  profileLogoUrl = STATE.profile.logo_url || null;
  document.getElementById('profileLogoPreview').innerHTML = profileLogoUrl ? `<img src="${profileLogoUrl}">` : '➕';
  document.getElementById('profShop').value = STATE.profile.shop_name || '';
  document.getElementById('profCategory').innerHTML = STATE.categories.map(c => `<option value="${c.id}" ${STATE.profile.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('');
  document.getElementById('profWhatsapp').value = STATE.profile.whatsapp || '';
  document.getElementById('profAddress').value = STATE.profile.address || '';
}
async function handleProfileLogoSelect(e) {
  const file = e.target.files[0]; if (!file) return;
  try {
    profileLogoUrl = await uploadFile('user-logos', file, STATE.user.id);
    document.getElementById('profileLogoPreview').innerHTML = `<img src="${profileLogoUrl}">`;
  } catch (err) { toast(err.message, true); }
}
async function saveProfile() {
  const payload = {
    shop_name: document.getElementById('profShop').value.trim() || STATE.profile.shop_name,
    category_id: document.getElementById('profCategory').value,
    whatsapp: document.getElementById('profWhatsapp').value.trim(),
    address: document.getElementById('profAddress').value.trim(),
    logo_url: profileLogoUrl
  };
  const { error } = await sb.from('profiles').update(payload).eq('id', STATE.user.id);
  if (error) { toast(error.message, true); return; }
  Object.assign(STATE.profile, payload);
  document.getElementById('avatarChip').textContent = (STATE.profile.shop_name || 'U').charAt(0).toUpperCase();
  toast('Profile updated');
  goto('dashboard');
}

// ===== Razorpay payment =====
// Payment happens through Razorpay (replacing the old UPI QR/manual-entry flow). As
// requested, the plan activates automatically the moment Razorpay confirms the payment
// succeeded — no separate admin approval step.
//
// ⚠️ Worth knowing: this activates directly from the browser as soon as Razorpay's success
// callback fires. That's simple and instant, but it is not the same as a server verifying
// Razorpay's payment signature — Razorpay's callback firing is a strong signal a real
// payment happened, but a determined person could still attempt to trigger this function
// without paying, since nothing server-side double-checks it. If that risk matters for your
// business, the hardened version of this (a Supabase Edge Function verifying the signature
// with your Razorpay Key Secret before writing to profiles/payments) can be added later —
// just ask.
const PLAN_DURATIONS = [
  { id: 'month1', label: '1 Month', months: 1, price: 299, note: 'One month of Premium access' },
  { id: 'month6', label: '6 Months', months: 6, price: 999, note: 'Six months of Premium access — best value', badge: true }
];
let selectedPlanDurationId = PLAN_DURATIONS[0].id;
function renderPayment() {
  selectedPlanDurationId = PLAN_DURATIONS[0].id;
  document.getElementById('paymentBody').innerHTML = `
    <div style="display:grid;gap:12px;margin-bottom:18px;">
      ${PLAN_DURATIONS.map(p => `
        <div class="pricing-card ${p.badge ? 'featured' : ''}" id="planCard-${p.id}" style="cursor:pointer;" onclick="selectPlanDuration('${p.id}')">
          <div class="pname">${p.label}</div>
          <div class="pprice">${fmtMoney(p.price)}</div>
          <p style="font-size:12.5px;color:var(--muted);margin:6px 0 0;">${p.note}</p>
          <p style="font-size:13px;font-weight:800;margin:6px 0 0;">${p.download_limit ? p.download_limit + ' downloads' : 'Unlimited downloads'}${p.video_limit ? ' · ' + p.video_limit + ' videos' : ''}</p>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-gold btn-block" onclick="payWithRazorpay()">💳 Pay with Razorpay</button>
    <p style="font-size:11.5px;color:var(--muted);text-align:center;margin-top:12px;">Pay by card, UPI, netbanking or wallet. Your plan activates automatically the moment payment succeeds.</p>`;
  selectPlanDuration(selectedPlanDurationId);
}
function selectPlanDuration(id) {
  selectedPlanDurationId = id;
  PLAN_DURATIONS.forEach(p => {
    const el = document.getElementById('planCard-' + p.id);
    if (el) el.classList.toggle('selected', p.id === id);
  });
}
function payWithRazorpay() {
  const plan = PLAN_DURATIONS.find(p => p.id === selectedPlanDurationId);
  if (!plan) return;
  if (typeof Razorpay === 'undefined') { toast('Payment system could not load — check your connection and try again.', true); return; }
  const rzpKey = (STATE.settings && STATE.settings.razorpay_key_id) || RAZORPAY_KEY_ID;
  if (!rzpKey || /YOUR_KEY_ID/.test(rzpKey)) { toast('Payments are not set up yet — the site owner must add the Razorpay Key ID (Admin → Pricing & Limits).', true); return; }
  const rzp = new Razorpay({
    key: rzpKey,
    amount: plan.price * 100,
    currency: 'INR',
    name: 'Offer Poster Studio',
    description: `${plan.label} Plan`,
    prefill: { email: STATE.user?.email || '' },
    theme: { color: '#0E6E5D' },
    // Explicitly listing methods (rather than omitting this) makes Razorpay show all of
    // these as options up front instead of only what it guesses is relevant — this is
    // usually what fixes UPI not appearing. It still only works if UPI is enabled for your
    // account in the Razorpay Dashboard (Settings → Payment Methods) — see the note below.
    method: { netbanking: true, card: true, upi: true, wallet: true },
    notes: { user_id: STATE.user?.id || '', plan_id: plan.id },
    // With the server webhook enabled (Admin → Pricing & Limits), the plan is activated by the server after Razorpay confirms
    // the money; the browser only waits for it. Otherwise (webhook not set up) fall back to browser-side activation.
    handler: (response) => (STATE.settings && STATE.settings.razorpay_webhook_on) ? waitForServerActivation(plan, response.razorpay_payment_id) : activatePlanAfterPayment(plan, response.razorpay_payment_id),
    modal: { ondismiss: () => toast('Payment cancelled') }
  });
  rzp.on('payment.failed', (response) => toast('Payment failed: ' + (response.error?.description || 'please try again') + (/^rzp_test_/.test(rzpKey) ? ' (Test mode: use test card 4111 1111 1111 1111 or UPI success@razorpay)' : ''), true));
  rzp.open();
}
// Activates the plan immediately: extends from the current expiry if it's still active
// (so renewing before expiry adds on top rather than restarting the clock), otherwise
// starts fresh from now. The existing expire_plans check (already called in boot()) is
// what automatically deactivates the plan once plan_expires_at passes — no new backend
// piece needed for that part.
// ---- plan download quotas (Admin → Plans: "downloads included") ----
async function quotaRemaining(kind) { // number left, or null when unlimited / free plan / not tracked
  const p = STATE.profile; if (!p || p.plan === 'free') return null;
  const lim = kind === 'video' ? p.plan_video_limit : p.plan_download_limit;
  if (lim == null || !p.plan_started_at) return null;
  let q = sb.from('downloads_log').select('id', { count: 'exact', head: true }).eq('user_id', STATE.user.id).gte('created_at', p.plan_started_at);
  q = kind === 'video' ? q.eq('format', 'studio-video') : q.neq('format', 'studio-video');
  const { count } = await q; return Math.max(0, lim - (count || 0));
}
async function planQuotaExceeded(kind) { const r = await quotaRemaining(kind); return r !== null && r <= 0; }
async function waitForServerActivation(plan, paymentId) {
  toast('Payment received — activating your plan…');
  for (let i = 0; i < 20; i++) { // up to ~40 s for the webhook to arrive
    await new Promise(r => setTimeout(r, 2000));
    const { data } = await sb.from('profiles').select('*').eq('id', STATE.user.id).single();
    if (data && data.plan && data.plan !== 'free' && (!STATE.profile.plan_expires_at || data.plan_expires_at !== STATE.profile.plan_expires_at)) {
      Object.assign(STATE.profile, data); toast(`Payment successful! ${plan.label} plan activated.`); goto('dashboard'); return;
    }
  }
  toast('Payment received. Your plan will activate in a moment — refresh the page. If it does not, contact support with payment ID ' + paymentId, true);
}
async function activatePlanAfterPayment(plan, paymentId) {
  try {
    const now = new Date();
    const currentExpiry = STATE.profile.plan_expires_at ? new Date(STATE.profile.plan_expires_at) : null;
    const base = (currentExpiry && currentExpiry > now) ? currentExpiry : now;
    const newExpiry = new Date(base); newExpiry.setMonth(newExpiry.getMonth() + plan.months);

    // Download quotas: a limited plan adds its allowance on top of whatever is left of an active limited plan.
    const active = STATE.profile.plan !== 'free' && currentExpiry && currentExpiry > now;
    let dl = plan.download_limit ?? null, vl = plan.video_limit ?? null;
    if (active) {
      const rd = dl != null ? await quotaRemaining('image') : null, rv = vl != null ? await quotaRemaining('video') : null;
      if (rd != null) dl += rd; if (rv != null) vl += rv;
    }
    const quotaFields = { plan_download_limit: dl, plan_video_limit: vl, plan_started_at: now.toISOString(), plan_id: plan.id };
    let { error: profErr } = await sb.from('profiles').update(Object.assign({ plan: 'premium', plan_expires_at: newExpiry.toISOString() }, quotaFields)).eq('id', STATE.user.id);
    if (profErr) { // quota columns not created yet — still activate the paid plan
      const r2 = await sb.from('profiles').update({ plan: 'premium', plan_expires_at: newExpiry.toISOString() }).eq('id', STATE.user.id); profErr = r2.error;
    } else Object.assign(STATE.profile, quotaFields);
    if (profErr) throw profErr;

    await sb.from('payments').insert({ user_id: STATE.user.id, plan: 'premium', amount: plan.price, upi_transaction_id: paymentId, status: 'completed' });

    STATE.profile.plan = 'premium';
    STATE.profile.plan_expires_at = newExpiry.toISOString();
    toast(`Payment successful! ${plan.label} plan activated.`);
    goto('dashboard');
  } catch (err) {
    console.error(err);
    toast('Payment succeeded but activating your plan failed — contact support with payment ID ' + paymentId, true);
  }
}

const HEADER_FRAC = 0.35, FOOTER_FRAC = 0.085;
const THEME_COLORS = [
  '#061B4A', '#082A73', '#0D5FDB', '#35A7FF', '#0EA5E9', '#0F766E', '#0891B2',
  '#F5B82E', '#FFD447', '#F47B20', '#EA580C', '#CA8A04', '#FFE066',
  '#DC2626', '#B91C1C', '#E1553B', '#BE185D', '#DB2777', '#F43F5E', '#FB7185',
  '#7C2D12', '#6D28D9', '#9333EA', '#4338CA', '#8B5CF6', '#A78BFA',
  '#166534', '#15803D', '#0E6E5D', '#22C55E', '#65A30D',
  '#111827', '#1F2937', '#FFFFFF', '#FFF8E8', '#FFD1DC', '#B4F8C8', '#A0E7E5'
];
const GRADIENT_PRESETS = [
  // Bold / vivid — high contrast, punchy for sale banners
  { id: 'supermarket', colors: ['#061B4A', '#0D5FDB', '#35A7FF'] },
  { id: 'gold', colors: ['#F5B82E', '#FFD447', '#F47B20'] },
  { id: 'premium', colors: ['#061B4A', '#082A73', '#F5B82E'] },
  { id: 'sunset', colors: ['#F47B20', '#FFD447'] },
  { id: 'ocean', colors: ['#061B4A', '#0D5FDB'] },
  { id: 'royal', colors: ['#082A73', '#8C3AA8'] },
  { id: 'festival', colors: ['#B91C1C', '#F5B82E'] },
  { id: 'berry', colors: ['#BE185D', '#7C3AED'] },
  { id: 'forest', colors: ['#052e16', '#15803D', '#84CC16'] },
  { id: 'midnight', colors: ['#0B1024', '#1E1B4B', '#4338CA'] },
  { id: 'candy', colors: ['#DB2777', '#F59E0B'] },
  { id: 'emerald', colors: ['#022c22', '#0F766E', '#2DD4BF'] },
  { id: 'cashback', colors: ['#7C2D12', '#DC2626', '#F97316'] },
  { id: 'saleburst', colors: ['#F59E0B', '#EC4899', '#7C3AED'] },
  { id: 'blackfriday', colors: ['#000000', '#111827', '#DC2626'] },
  { id: 'neonpink', colors: ['#DB2777', '#8B5CF6', '#06B6D4'] },
  { id: 'ruby', colors: ['#450a0a', '#B91C1C', '#FCA5A5'] },
  { id: 'tropical', colors: ['#059669', '#FACC15', '#F97316'] },
  { id: 'galaxy', colors: ['#1E1B4B', '#7C3AED', '#EC4899'] },
  { id: 'lagoon', colors: ['#003049', '#0891B2', '#5EEAD4'] },
  { id: 'volcano', colors: ['#1c1204', '#EA580C', '#FDE047'] },
  { id: 'sapphire', colors: ['#020617', '#1D4ED8', '#38BDF8'] },
  // Light / soft pastel mixes — for a lighter, gentler "adipoli" look
  { id: 'peachlight', colors: ['#FFEDD5', '#FED7AA', '#FCA5A5'] },
  { id: 'mintlight', colors: ['#D1FAE5', '#A7F3D0', '#5EEAD4'] },
  { id: 'lilaclight', colors: ['#EDE9FE', '#DDD6FE', '#FBCFE8'] },
  { id: 'skylight', colors: ['#E0F2FE', '#BAE6FD', '#93C5FD'] },
  { id: 'blushlight', colors: ['#FFF1F2', '#FBCFE8', '#F9A8D4'] },
  { id: 'lemonlight', colors: ['#FEFCE8', '#FEF08A', '#FDE047'] },
  { id: 'limelight', colors: ['#F7FEE7', '#D9F99D', '#BEF264'] },
  { id: 'creamgold', colors: ['#FFFBEB', '#FDE68A', '#FBBF24'] },
  { id: 'roseGold', colors: ['#FFF1E6', '#FBCFE8', '#F0ABFC'] }
];
const BUILTIN_STICKERS = [
  { cat: 'festival', items: ['🎉', '🪔', '🎊', '🌟', '🎆', '🕌', '🎄', '🧨', '🥳', '🎇'] },
  { cat: 'badges', items: ['🏷️', '🔥', '⭐', '💯', '✅', '🆕', '⚡', '🎯'] },
  { cat: 'general', items: ['❤️', '👍', '🛍️', '🎁', '📢', '💰', '🛒', '⏰'] },
];
// Real drawn badge graphics (not emoji) for the bold "sale poster" look — starburst % OFF
// tags, ribbon-style SALE badges, etc. Draggable/resizable/rotatable like any other sticker.
const BADGE_PRESETS = [
  { id: 'off50', shape: 'burst', lines: ['50%', 'OFF'], bg: '#8C3AA8', fg: '#ffffff' },
  { id: 'off70', shape: 'burst', lines: ['75%', 'OFF'], bg: '#DC2626', fg: '#ffffff' },
  { id: 'off30', shape: 'circle', lines: ['30%', 'OFF'], bg: '#059669', fg: '#ffffff' },
  { id: 'sale', shape: 'circle', lines: ['SALE'], bg: '#F59E0B', fg: '#1c1204' },
  { id: 'hotdeal', shape: 'burst', lines: ['HOT', 'DEAL'], bg: '#EA580C', fg: '#ffffff' },
  { id: 'dontmiss', shape: 'ribbon', lines: ["DON'T", 'MISS IT'], bg: '#B91C1C', fg: '#ffffff' },
  { id: 'newarrival', shape: 'circle', lines: ['NEW'], bg: '#0EA5E9', fg: '#ffffff' },
  { id: 'limited', shape: 'ribbon', lines: ['LIMITED', 'OFFER'], bg: '#111827', fg: '#ffffff' }
];
// Full ready-made banner presets matching the bold "sale poster" reference style — theme,
// headline, font and badge stickers already set up; the person just adds their own photo,
// shop name and contact details on top.
const BOLD_POSTER_PRESETS = [
  {
    id: 'cashback', title: 'Cashback Offer', thumb: 'linear-gradient(135deg,#7C2D12,#DC2626,#F97316)',
    themeGradientId: 'cashback', font: 'titan',
    headline: '100% OFF CASHBACK OFFER', dateRange: 'ONLY FOR TWO DAYS', discount: '',
    badges: []
  },
  {
    id: 'saleburst', title: 'Sale Burst', thumb: 'linear-gradient(135deg,#F59E0B,#EC4899,#7C3AED)',
    themeGradientId: 'saleburst', font: 'chango',
    headline: 'SALE ONLY TODAY', dateRange: 'THIS WEEK ONLY', discount: '',
    badges: [{ presetId: 'sale', x: 0.33, y: 0.6, scale: 1.9 }, { presetId: 'off50', x: 0.78, y: 0.68, scale: 1.2 }]
  },
  {
    id: 'blackfriday', title: 'Black Friday Sale', thumb: 'linear-gradient(135deg,#000000,#111827,#DC2626)',
    themeGradientId: 'blackfriday', font: 'anton',
    headline: 'BLACK FRIDAY SALE', dateRange: '25 NOV', discount: 'UP TO 75% OFF',
    badges: [{ presetId: 'dontmiss', x: 0.86, y: 0.14, scale: 1.05 }]
  }
];
// Ready-made single-product-photo poster templates: one big product photo slot with a
// placeholder image + sample price/name — replace the photo and edit every text exactly
// like any other poster, the bold theme/headline/badge are just the starting point.
const SINGLE_PRODUCT_PRESETS = [
  {
    id: 'freshdeal', title: 'Fresh Deal', thumb: 'linear-gradient(135deg,#022c22,#0F766E,#2DD4BF)',
    themeGradientId: 'emerald', font: 'righteous',
    headline: 'FRESH DEAL TODAY', dateRange: 'LIMITED STOCK', discount: '',
    demoImg: 0, mrp: '199', offerPrice: '149',
    badges: [{ presetId: 'off30', x: 0.82, y: 0.18, scale: 1.1 }]
  },
  {
    id: 'megasale', title: 'Mega Sale', thumb: 'linear-gradient(135deg,#7C2D12,#EA580C,#F59E0B)',
    themeGradientId: 'sunset', font: 'bungee',
    headline: 'MEGA SALE OFFER', dateRange: 'THIS WEEKEND', discount: '',
    demoImg: 1, mrp: '999', offerPrice: '599',
    badges: [{ presetId: 'off50', x: 0.82, y: 0.18, scale: 1.15 }]
  },
  {
    id: 'newarrival', title: 'New Arrival', thumb: 'linear-gradient(135deg,#061B4A,#0D5FDB,#35A7FF)',
    themeGradientId: 'ocean', font: 'russo',
    headline: 'NEW ARRIVAL', dateRange: 'JUST LAUNCHED', discount: '',
    demoImg: 2, mrp: '', offerPrice: '499',
    badges: [{ presetId: 'newarrival', x: 0.82, y: 0.18, scale: 1.1 }]
  },
  {
    id: 'bestprice', title: 'Best Price', thumb: 'linear-gradient(135deg,#082A73,#8C3AA8)',
    themeGradientId: 'royal', font: 'paytone',
    headline: 'BEST PRICE GUARANTEE', dateRange: '', discount: '',
    demoImg: 3, mrp: '799', offerPrice: '549',
    badges: []
  },
  {
    id: 'flashsale', title: 'Flash Sale', thumb: 'linear-gradient(135deg,#111827,#DC2626)',
    themeGradientId: 'blackfriday', font: 'titan',
    headline: 'FLASH SALE', dateRange: 'TODAY ONLY', discount: '',
    demoImg: 4, mrp: '1299', offerPrice: '699',
    badges: [{ presetId: 'off70', x: 0.82, y: 0.18, scale: 1.15 }]
  },
  {
    id: 'premiumpick', title: 'Premium Pick', thumb: 'linear-gradient(135deg,#1c1204,#B8842E,#F5B82E)',
    themeGradientId: 'gold', font: 'lilita',
    headline: 'PREMIUM PICK', dateRange: '', discount: '',
    demoImg: 5, mrp: '', offerPrice: '',
    badges: [{ presetId: 'sale', x: 0.82, y: 0.18, scale: 1 }]
  }
];
const ML_PHRASES = ['🌙Ramadan Offer','🌸Onam Festival','🎄Christmas Carnival','🕌Eid Offers','🪔Diwali Sale','👗Fashion Sale','📱Mobile Fest','🛒Grocery Offer','💍Jewellery Offer','🧴Beauty Sale','🏠Home Essentials','🛍️ഇന്ന്.മാത്രം ഓഫർ', '🛍️മെഗാ സെയിൽ', '🛍️വമ്പൻ വിലക്കുറവ്', '📦സ്റ്റോക്ക് ക്ലിയറൻസ്', '🌸ഓണം.സ്പെഷ്യൽ ഓഫർ', '🧨വിഷു ഓഫർ', '🌜പെരുന്നാൾ ഓഫർ', '🚚പരിമിതകാല ഓഫർ'];
const EN_PHRASES = ['🔥MEGA OFFER', '🛍️BIG SALE', '🎉GRAND SALE', '💥UP TO 50% OFF', '🏷️FLAT DISCOUNT', '⏰LIMITED TIME OFFER', '📅TODAY ONLY', '⭐BEST PRICE', '🎊FESTIVE OFFER', '💰SUPER SAVINGS', '📦CLEARANCE SALE', '✨SPECIAL OFFER', '🛒BUY NOW'];
const FONT_OPTIONS = [
  { id: 'display', label: 'Fraunces', css: "'Fraunces', serif" },
  { id: 'body', label: 'Manrope', css: "'Manrope', sans-serif" },
  { id: 'ml', label: 'Malayalam', css: "'Noto Sans Malayalam','Manrope', sans-serif" },
  { id: 'ml-baloo', label: 'മലയാളം അടിപൊളി', css: "'Baloo Chettan 2','Noto Sans Malayalam',sans-serif" },
  { id: 'ml-manjari', label: 'മലയാളം ബോൾഡ്', css: "'Manjari','Noto Sans Malayalam',sans-serif" },
  { id: 'ml-chilanka', label: 'മലയാളം സ്റ്റൈൽ', css: "'Chilanka','Noto Sans Malayalam',cursive" },
  { id: 'ml-gayathri', label: 'മലയാളം ഗായത്രി', css: "'Gayathri','Noto Sans Malayalam',sans-serif" },
  { id: 'ml-serif', label: 'മലയാളം ക്ലാസിക്', css: "'Noto Serif Malayalam','Noto Sans Malayalam',serif" },
  { id: 'ml-suranna', label: 'മലയാളം എലഗന്റ്', css: "'Suranna','Noto Serif Malayalam',serif" },
  { id: 'ml-uroob', label: 'മലയാളം കാലിഗ്രഫി', css: "'Uroob','Noto Sans Malayalam',cursive" },
  { id: 'hi', label: 'Hindi', css: "'Noto Sans Devanagari','Manrope',sans-serif" },
  { id: 'hi-baloo', label: 'हिंदी बोल्ड', css: "'Baloo 2','Noto Sans Devanagari',sans-serif" },
  { id: 'hi-yatra', label: 'हिंदी स्टाइल', css: "'Yatra One','Noto Sans Devanagari',cursive" },
  { id: 'hi-kalam', label: 'हिंदी लिखावट', css: "'Kalam','Noto Sans Devanagari',cursive" },
  { id: 'bn', label: 'Bengali', css: "'Noto Sans Bengali','Manrope',sans-serif" },
  { id: 'bn-baloo', label: 'বাংলা বোল্ড', css: "'Baloo Da 2','Noto Sans Bengali',sans-serif" },
  { id: 'bn-galada', label: 'বাংলা স্টাইল', css: "'Galada','Noto Sans Bengali',cursive" },
  { id: 'pa', label: 'Punjabi', css: "'Noto Sans Gurmukhi','Manrope',sans-serif" },
  { id: 'pa-baloo', label: 'ਪੰਜਾਬੀ ਬੋਲਡ', css: "'Baloo Paaji 2','Noto Sans Gurmukhi',sans-serif" },
  { id: 'pa-mukta', label: 'ਪੰਜਾਬੀ ਸਟਾਈਲ', css: "'Mukta Mahee','Noto Sans Gurmukhi',sans-serif" },
  { id: 'gu', label: 'Gujarati', css: "'Noto Sans Gujarati','Manrope',sans-serif" },
  { id: 'gu-baloo', label: 'ગુજરાતી બોલ્ડ', css: "'Baloo Bhai 2','Noto Sans Gujarati',sans-serif" },
  { id: 'gu-rasa', label: 'ગુજરાતી એલિગન્ટ', css: "'Rasa','Noto Sans Gujarati',serif" },
  { id: 'or', label: 'Odia', css: "'Noto Sans Oriya','Manrope',sans-serif" },
  { id: 'or-baloo', label: 'ଓଡ଼ିଆ ବୋଲ୍ଡ', css: "'Baloo Bhaina 2','Noto Sans Oriya',sans-serif" },
  { id: 'or-utsaah', label: 'ଓଡ଼ିଆ ଷ୍ଟାଇଲ୍', css: "'Utsaah','Noto Sans Oriya',sans-serif" },
  { id: 'ta', label: 'Tamil', css: "'Noto Sans Tamil','Manrope',sans-serif" },
  { id: 'ta-baloo', label: 'தமிழ் போல்ட்', css: "'Baloo Thambi 2','Noto Sans Tamil',sans-serif" },
  { id: 'ta-kavi', label: 'தமிழ் கையெழுத்து', css: "'Kavivanar','Noto Sans Tamil',cursive" },
  { id: 'te', label: 'Telugu', css: "'Noto Sans Telugu','Manrope',sans-serif" },
  { id: 'te-baloo', label: 'తెలుగు బోల్డ్', css: "'Baloo Tammudu 2','Noto Sans Telugu',sans-serif" },
  { id: 'te-mallanna', label: 'తెలుగు స్టైల్', css: "'Mallanna','Noto Sans Telugu',sans-serif" },
  { id: 'kn', label: 'Kannada', css: "'Noto Sans Kannada','Manrope',sans-serif" },
  { id: 'kn-baloo', label: 'ಕನ್ನಡ ಬೋಲ್ಡ್', css: "'Baloo Tamma 2','Noto Sans Kannada',sans-serif" },
  { id: 'kn-hubballi', label: 'ಕನ್ನಡ ಶೈಲಿ', css: "'Hubballi','Noto Sans Kannada',cursive" },
  { id: 'ur', label: 'Urdu', css: "'Noto Nastaliq Urdu','Manrope',sans-serif" },
  { id: 'ur-gulzar', label: 'اردو اسٹائل', css: "'Gulzar','Noto Nastaliq Urdu',cursive" },
  { id: 'bungee-shade', label: 'Bungee 3D', css: 'Bungee Shade, cursive' },
  { id: 'bungee', label: 'Bungee', css: 'Bungee, cursive' },
  { id: 'bowlby', label: 'Bowlby', css: 'Bowlby One SC, sans-serif' },
  { id: 'titan', label: 'Titan', css: 'Titan One, sans-serif' },
  { id: 'anton', label: 'Anton', css: 'Anton, sans-serif' },
  { id: 'bebas', label: 'Bebas', css: 'Bebas Neue, sans-serif' },
  { id: 'russo', label: 'Russo', css: 'Russo One, sans-serif' },
  { id: 'righteous', label: 'Righteous', css: 'Righteous, sans-serif' },
  { id: 'luckiest', label: 'Luckiest', css: 'Luckiest Guy, cursive' },
  { id: 'lilita', label: 'Lilita', css: 'Lilita One, cursive' },
  { id: 'chango', label: 'Chango', css: 'Chango, cursive' },
  { id: 'coiny', label: 'Coiny', css: 'Coiny, cursive' },
  { id: 'paytone', label: 'Paytone', css: 'Paytone One, sans-serif' }
];
// Every Indian script the app supports fonts for, in the order checked. Each group knows
// which of its own fonts are "native" to it (so picking one of those in the Style tab makes
// text in that script render in that exact look) and a safe default (Noto Sans for the script) to
// fall back to if the person picked a Latin font while typing in that script — so text never
// renders as boxes/tofu.
const SCRIPT_GROUPS = [
  { key: 'ml', regex: /[\u0D00-\u0D7F]/, fontIds: ['ml', 'ml-baloo', 'ml-manjari', 'ml-chilanka', 'ml-gayathri', 'ml-serif', 'ml-suranna', 'ml-uroob'], defaultId: 'ml' },
  { key: 'hi', regex: /[\u0900-\u097F]/, fontIds: ['hi', 'hi-baloo', 'hi-yatra', 'hi-kalam'], defaultId: 'hi' },
  { key: 'bn', regex: /[\u0980-\u09FF]/, fontIds: ['bn', 'bn-baloo', 'bn-galada'], defaultId: 'bn' },
  { key: 'pa', regex: /[\u0A00-\u0A7F]/, fontIds: ['pa', 'pa-baloo', 'pa-mukta'], defaultId: 'pa' },
  { key: 'gu', regex: /[\u0A80-\u0AFF]/, fontIds: ['gu', 'gu-baloo', 'gu-rasa'], defaultId: 'gu' },
  { key: 'or', regex: /[\u0B00-\u0B7F]/, fontIds: ['or', 'or-baloo', 'or-utsaah'], defaultId: 'or' },
  { key: 'ta', regex: /[\u0B80-\u0BFF]/, fontIds: ['ta', 'ta-baloo', 'ta-kavi'], defaultId: 'ta' },
  { key: 'te', regex: /[\u0C00-\u0C7F]/, fontIds: ['te', 'te-baloo', 'te-mallanna'], defaultId: 'te' },
  { key: 'kn', regex: /[\u0C80-\u0CFF]/, fontIds: ['kn', 'kn-baloo', 'kn-hubballi'], defaultId: 'kn' },
  { key: 'ur', regex: /[\u0600-\u06FF]/, fontIds: ['ur', 'ur-gulzar'], defaultId: 'ur' }
];
const MALAYALAM_FONT_IDS = SCRIPT_GROUPS[0].fontIds;
// Picks the right font for a piece of text: detects which Indian script (if any) it's
// written in, and if the person has chosen one of that script's own fonts in the Style tab,
// uses that font's exact look (e.g. the bold "അടിപൊളി" Baloo style); otherwise falls back to
// that script's safe default font so text never renders as boxes/tofu — and Latin text keeps
// using whatever font was picked, same as before.
function resolveTextFontCss(ed, content, fontFamily) {
  for (const group of SCRIPT_GROUPS) {
    if (group.regex.test(content)) {
      const chosen = group.fontIds.includes(ed.font) ? ed.font : group.defaultId;
      const f = FONT_OPTIONS.find(f => f.id === chosen);
      return f ? f.css : fontFamily;
    }
  }
  return fontFamily;
}

function getSlotRects(count, layoutType = 'grid') {
  const gap = 0.012, rects = [];
  const n = parseInt(count);
 
  // 1️⃣ Weekend Loot സ്റ്റൈൽ ലേഔട്ട്
  if (layoutType === 'layout_loot') {
    rects.push({ x: 0.02, y: 0.02, w: 0.45, h: 0.30 }); 
    rects.push({ x: 0.50, y: 0.02, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.02, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.50, y: 0.18, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.18, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.02, y: 0.34, w: 0.45, h: 0.30 }); 
    rects.push({ x: 0.50, y: 0.34, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.34, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.50, y: 0.50, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.50, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.02, y: 0.66, w: 0.45, h: 0.30 }); 
    rects.push({ x: 0.50, y: 0.66, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.66, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.50, y: 0.82, w: 0.22, h: 0.14 }); 
    rects.push({ x: 0.74, y: 0.82, w: 0.22, h: 0.14 }); 
    return rects;
  }

  // 2️⃣ Eid Night Fiesta സ്റ്റൈൽ ലേഔട്ട്
  if (layoutType === 'layout_fiesta') {
    rects.push({ x: 0.02, y: 0.02, w: 0.22, h: 0.20 });
    rects.push({ x: 0.26, y: 0.02, w: 0.22, h: 0.20 });
    rects.push({ x: 0.50, y: 0.02, w: 0.22, h: 0.20 });
    rects.push({ x: 0.74, y: 0.02, w: 0.22, h: 0.20 });
    rects.push({ x: 0.02, y: 0.24, w: 0.46, h: 0.38 }); 
    rects.push({ x: 0.50, y: 0.24, w: 0.46, h: 0.20 }); 
    rects.push({ x: 0.50, y: 0.46, w: 0.22, h: 0.16 });
    rects.push({ x: 0.74, y: 0.46, w: 0.22, h: 0.16 });
    rects.push({ x: 0.02, y: 0.64, w: 0.22, h: 0.18 });
    rects.push({ x: 0.26, y: 0.64, w: 0.22, h: 0.18 });
    rects.push({ x: 0.50, y: 0.64, w: 0.46, h: 0.18 });
    rects.push({ x: 0.02, y: 0.84, w: 0.22, h: 0.14 });
    rects.push({ x: 0.26, y: 0.84, w: 0.22, h: 0.14 });
    rects.push({ x: 0.50, y: 0.84, w: 0.22, h: 0.14 });
    rects.push({ x: 0.74, y: 0.84, w: 0.22, h: 0.14 });
    return rects;
  }

  // 3️⃣ Buy More Save More ലേഔട്ട്
  if (layoutType === 'layout_buymore') {
    rects.push({ x: 0.02, y: 0.02, w: 0.31, h: 0.30 });
    rects.push({ x: 0.35, y: 0.02, w: 0.31, h: 0.30 });
    rects.push({ x: 0.68, y: 0.02, w: 0.30, h: 0.30 });
    rects.push({ x: 0.02, y: 0.34, w: 0.48, h: 0.32 }); 
    rects.push({ x: 0.52, y: 0.34, w: 0.46, h: 0.32 }); 
    rects.push({ x: 0.02, y: 0.68, w: 0.31, h: 0.30 });
    rects.push({ x: 0.35, y: 0.68, w: 0.31, h: 0.30 });
    rects.push({ x: 0.68, y: 0.68, w: 0.30, h: 0.30 });
    return rects;
  }

  // 4️⃣ Onam Special ലേഔട്ട്
  if (layoutType === 'layout_onam') {
    rects.push({ x: 0.02, y: 0.02, w: 0.31, h: 0.31 });
    rects.push({ x: 0.35, y: 0.02, w: 0.31, h: 0.31 });
    rects.push({ x: 0.68, y: 0.02, w: 0.30, h: 0.31 });
    rects.push({ x: 0.02, y: 0.35, w: 0.48, h: 0.31 });
    rects.push({ x: 0.52, y: 0.35, w: 0.46, h: 0.31 });
    rects.push({ x: 0.02, y: 0.68, w: 0.31, h: 0.30 });
    rects.push({ x: 0.35, y: 0.68, w: 0.31, h: 0.30 });
    rects.push({ x: 0.68, y: 0.68, w: 0.30, h: 0.30 });
    return rects;
  }

  // സാധാരണ ഗ്രീഡ് ലേഔട്ടുകൾ
  if (n === 4 && layoutType === 'combo') {
    rects.push({ x: 0, y: 0, w: 1, h: 0.52 });
    rects.push({ x: 0, y: 0.54, w: 0.32, h: 0.44 });
    rects.push({ x: 0.34, y: 0.54, w: 0.32, h: 0.44 });
    rects.push({ x: 0.68, y: 0.54, w: 0.32, h: 0.44 });
    return rects;
  }
  
  

  if (n === 4 && layoutType === 'combo') {
    rects.push({ x: 0, y: 0, w: 1, h: 0.52 });
    rects.push({ x: 0, y: 0.54, w: 0.32, h: 0.44 });
    rects.push({ x: 0.34, y: 0.54, w: 0.32, h: 0.44 });
    rects.push({ x: 0.68, y: 0.54, w: 0.32, h: 0.44 });
    return rects;
  }
  function grid(cols, rows) {
    const cw = (1 - gap * (cols + 1)) / cols, rh = (1 - gap * (rows + 1)) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) rects.push({ x: gap + c * (cw + gap), y: gap + r * (rh + gap), w: cw, h: rh });
  }
  if (n === 1) rects.push({ x: 0, y: 0, w: 1, h: 1 });
  else if (n === 2) grid(2, 1); else if (n === 4) grid(2, 2); else if (n === 6) grid(3, 2);
  else if (n === 9) grid(3, 3); else if (n === 12) grid(4, 3); else if (n === 20) grid(4, 5); else grid(2, 2);
  return rects;
}

const DEMO_STOCK_IMAGES = [
  'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&q=60',
  'https://images.unsplash.com/photo-1550989460-0adf9ea622e2?w=400&q=60',
  'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=400&q=60',
  'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=400&q=60',
  'https://images.unsplash.com/photo-1567306301408-9b74779a11af?w=400&q=60',
  'https://images.unsplash.com/photo-1512909006721-3d6018887383?w=400&q=60',
  'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=400&q=60',
  'https://images.unsplash.com/photo-1573883431205-98b5f10aaedb?w=400&q=60',
  'https://images.unsplash.com/photo-1519744792095-2f2205e87b6f?w=400&q=60',
  'https://images.unsplash.com/photo-1607083206968-13611e3d76db?w=400&q=60',
  'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=60',
  'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=400&q=60',
];
function demoSlotPhoto(i) {
  if (STATE.products && STATE.products.length) {
    const p = STATE.products[i % STATE.products.length];
    return { img: p.image_url, mrp: p.mrp ? String(p.mrp) : '', offerPrice: p.offer_price ? String(p.offer_price) : '', offerText: p.name };
  }
  return { img: DEMO_STOCK_IMAGES[i % DEMO_STOCK_IMAGES.length], mrp: '', offerPrice: '', offerText: '' };
}

function renderHeaderTplLibrary() {
  const BUILTIN_HEADER_BANNERS = [
    { image_url: 'https://images.unsplash.com/photo-1607083206968-13611e3d76db?w=600&q=80' },
    { image_url: 'https://images.unsplash.com/photo-1555421689-491a97ff2040?w=600&q=80' },
    { image_url: 'https://images.unsplash.com/photo-1534452203293-494d7ddbf7e0?w=600&q=80' },
    { image_url: 'https://images.unsplash.com/photo-1513151233558-d860539817?w=600&q=80' }
  ];
  const banners = (STATE.banners && STATE.banners.length > 0) ? STATE.banners : BUILTIN_HEADER_BANNERS;
  const grid = document.getElementById('headerTplLibraryGrid');
  if (grid) {
    grid.innerHTML = banners.length ? banners.map(b => `
      <div class="sticker-item" onclick="applyHeaderBanner('${b.image_url}')" style="aspect-ratio:16/9; cursor:pointer; overflow:hidden; border-radius:10px; background:#eee; border: 1.5px solid var(--line);">
        <img src="${b.image_url}" style="width:100%; height:100%; object-fit:cover; display:block;" crossorigin="anonymous">
      </div>
    `).join('') : '<p style="font-size:12px;color:var(--muted);text-align:center;padding:20px;">No header templates available.</p>';
  }
}
function applyHeaderBanner(url) {
  pushHistory();
  STATE.editor.heroBanner = url;
  renderPoster();
  toast('Top banner applied!');
}
function removeHeaderBanner() {
  pushHistory();
  STATE.editor.heroBanner = null;
  renderPoster();
  toast('Top banner removed');
}

function defaultTextLayers() {
  return [
    { id: 'headerShop', key: 'headerShop', x: 0.5, y: 0.045, scale: 1, rotation: 0, curve: 0, visible: true },
    { id: 'headline', key: 'headline', x: 0.5, y: 0.175, scale: 1, rotation: 0, curve: 0, visible: true },
    { id: 'pill', key: 'pill', x: 0.5, y: 0.30, scale: 1, rotation: 0, curve: 0, visible: true },
    { id: 'footerShop', key: 'footerShop', x: 0.16, y: 0.945, scale: 1, rotation: 0, curve: 0, visible: true },
    { id: 'footerAddress', key: 'footerAddress', x: 0.16, y: 0.978, scale: 1, rotation: 0, curve: 0, visible: true },
    { id: 'footerWhatsapp', key: 'footerWhatsapp', x: 0.84, y: 0.955, scale: 1, rotation: 0, curve: 0, visible: true }
  ];
}
function ensureTexts(ed) { if (ed && !ed.texts) { ed.texts = defaultTextLayers(); } return ed ? ed.texts : null; }
function textLayerContent(ed, key) {
  switch (key) {
    case 'headerShop': return (ed.shopName || '').toUpperCase();
    case 'headline': return ed.headline || '';
    case 'pill': return ed.dateRange || ed.discount || '';
    case 'footerShop': return ed.shopName || '';
    case 'footerAddress': return ed.address || '';
    case 'footerWhatsapp': return ed.whatsapp ? ('📞 ' + ed.whatsapp) : '';
    default: return '';
  }
}
function textLayerFieldKey(key) {
  return { headerShop: 'shopName', headline: 'headline', pill: 'dateRange', footerShop: 'shopName', footerAddress: 'address', footerWhatsapp: 'whatsapp' }[key];
}
function textLayerLabel(key) {
  return { headerShop: 'Shop Name (Header)', headline: 'Offer Headline', pill: 'Date / Discount Pill', footerShop: 'Shop Name (Footer)', footerAddress: 'Address', footerWhatsapp: 'WhatsApp Number' }[key] || 'Text';
}
function textLayerBaseSizeFrac(key) {
  return { headerShop: 0.030, headline: 0.078, pill: 0.030, footerShop: 0.036, footerAddress: 0.026, footerWhatsapp: 0.030 }[key] || 0.03;
}

function blankEditorState(template) {
  return {
    templateId: template ? template.id : null,
    title: template ? template.title : 'Blank Poster',
    theme: template ? template.theme_color : THEME_COLORS[0],
    layout: template ? template.layout : '4',
    layoutType: 'grid',
    themeType: 'solid', themeGradient: GRADIENT_PRESETS[0].colors,
    font: 'display',
    shopName: STATE.profile.shop_name || 'നിങ്ങളുടെ കടയുടെ പേര്',
    headline: template && template.festival ? (template.festival + ' 🛍️ഓഫർ') : '🛍️ഇന്ന്.മാത്രം ഓഫർ',
    dateRange: '', price: '₹499', discount: 'വൻ വിലക്കുറവ്',
    whatsapp: STATE.profile.whatsapp || '+91 0000000000',
    address: STATE.profile.address || 'ബസ് സ്റ്റാൻഡിന് സമീപം / Near Bus Stand',
    logo: STATE.profile.logo_url || null,
    logoScale: 1, logoWidthScale: 1, logoHeightScale: 1, logoX: 0.05, logoY: 0.04,
    heroBanner: template ? (template.hero_banner_url || null) : null,
    stickers: [],
    texts: defaultTextLayers(),
    slots: getSlotRects(template ? template.layout : '4', 'grid').map((r, i) => ({
      ...r, offX: 0.5, offY: 0.5, zoom: 1,
      ...(template ? demoSlotPhoto(i) : { img: null, mrp: '', offerPrice: '', offerText: '' })
    })),
    id: uid(), dbId: null
  };
}
function openTemplate(id) {
  const t = STATE.templates.find(t => t.id === id); if (!t) return;
  if (isPremiumLocked(t)) { goto('payment'); return; }
  STATE.editor = blankEditorState(t);
  enterEditor();
}
function startBlankPoster() { STATE.editor = blankEditorState(null); enterEditor(); }
function enterEditor() {
  ensureTexts(STATE.editor);
  goto('editor');
  document.getElementById('editorTitle').textContent = STATE.editor.title;
  document.getElementById('fShopName').value = STATE.editor.shopName;
  document.getElementById('fHeadline').value = STATE.editor.headline;
  document.getElementById('fDateRange').value = STATE.editor.dateRange;
  document.getElementById('fPrice').value = STATE.editor.price;
  document.getElementById('fDiscount').value = STATE.editor.discount;
  document.getElementById('fWhatsapp').value = STATE.editor.whatsapp;
  document.getElementById('fAddress').value = STATE.editor.address;
  document.getElementById('logoUpload').innerHTML = STATE.editor.logo ? `<img src="${STATE.editor.logo}">` : '➕';
  renderSlotGrid(); renderColorSwatches(); renderTextColorSwatches(); renderPillColorSwatches(); renderProductColorSwatches(); renderBorderlessToggle(); renderFontChips(); renderLayoutChips(); renderStickerLibrary(); renderBadgeLibrary(); renderShapeLibrary(); renderStickerControls(); renderElementControls(); renderMlQuick(); renderEnQuick(); renderTextControls(); renderTextLayerChips();
  updatePlanBanner(); setEditorTab('photos'); resetZoom();
  historyStack = []; redoStack = []; updateUndoRedoButtons();
  renderPoster();
}
function startShelfTagPoster() {
  STATE.editor = {
    templateId: null,
    title: 'Shelf Price Tag',
    layout: 'shelftag',
    layoutType: 'grid',
    theme: '#FFFFFF',
    themeType: 'solid', 
    themeGradient: GRADIENT_PRESETS[0].colors,
    font: 'display',
    shopName: STATE.profile.shop_name || 'offer poster studio ',
    headline: 'MEGA OFFER',
    dateRange: '25 MAY 2024', 
    price: '279', 
    discount: '13% OFF',
    whatsapp: STATE.profile.whatsapp || '',
    address: STATE.profile.address || '',
    logo: STATE.profile.logo_url || null,
    logoScale: 1, logoWidthScale: 1, logoHeightScale: 1, logoX: 0.85, logoY: 0.08,
    heroBanner: null,
    stickers: [],
    texts: defaultTextLayers(),
    slots: [{
      x: 0, y: 0, w: 1, h: 1, offX: 0.5, offY: 0.5, zoom: 1,
      img: STATE.products && STATE.products.length ? STATE.products[0].image_url : DEMO_STOCK_IMAGES[0],
      mrp: '320', 
      offerPrice: '279', 
      offerText: 'AASHIRVAAD ATTA 5 KG'
    }],
    id: uid(), 
    dbId: null
  };
  
  enterEditor();
  toast('Professional Shelf Tag loaded!');
}
function startBoldSalePoster(id) {
  const preset = BOLD_POSTER_PRESETS.find(p => p.id === id); if (!preset) return;
  const grad = GRADIENT_PRESETS.find(g => g.id === preset.themeGradientId);
  STATE.editor = blankEditorState(null);
  STATE.editor.title = preset.title;
  STATE.editor.themeType = 'gradient';
  STATE.editor.themeGradient = grad ? grad.colors : STATE.editor.themeGradient;
  STATE.editor.font = preset.font;
  STATE.editor.headline = preset.headline;
  STATE.editor.dateRange = preset.dateRange || '';
  STATE.editor.discount = preset.discount || '';
  STATE.editor.stickers = (preset.badges || []).map(b => {
    const bp = BADGE_PRESETS.find(x => x.id === b.presetId) || BADGE_PRESETS[0];
    return {
      id: uid(), badge: true, badgeId: b.presetId,
      shape: bp.shape, lines: [...bp.lines], bg: bp.bg, fg: bp.fg,
      x: b.x, y: b.y, scale: b.scale || 1, rotation: b.rotation || 0
    };
  });
  enterEditor();
  toast(preset.title + ' banner loaded!');
}
function renderBoldSaleRow() {
  const row = document.getElementById('boldSaleRow'); if (!row) return;
  row.innerHTML = BOLD_POSTER_PRESETS.map(p => `
    <div class="tcard" onclick="startBoldSalePoster('${p.id}')">
      <div class="thumb" style="background:${p.thumb};display:flex;align-items:center;justify-content:center;">
        <span class="badge">BOLD</span>
        <div class="tlabel" style="text-shadow:0 2px 6px rgba(0,0,0,.6);">${escapeHtml(p.title)}</div>
      </div>
      <div class="meta"><div class="cat">Ready-made banner</div>
        <button class="use-btn" onclick="event.stopPropagation();startBoldSalePoster('${p.id}')">Create Banner</button>
      </div>
    </div>
  `).join('');
}
function startSingleProductPoster(id) {
  const preset = SINGLE_PRODUCT_PRESETS.find(p => p.id === id); if (!preset) return;
  const grad = GRADIENT_PRESETS.find(g => g.id === preset.themeGradientId);
  STATE.editor = blankEditorState(null);
  STATE.editor.title = preset.title;
  STATE.editor.layout = '1';
  STATE.editor.layoutType = 'grid';
  STATE.editor.borderless = true;
  STATE.editor.themeType = 'gradient';
  STATE.editor.themeGradient = grad ? grad.colors : STATE.editor.themeGradient;
  STATE.editor.font = preset.font;
  STATE.editor.headline = preset.headline;
  STATE.editor.dateRange = preset.dateRange || '';
  STATE.editor.discount = preset.discount || '';
  const rect = getSlotRects('1', 'grid')[0];
  const demoImg = STATE.products && STATE.products.length
    ? STATE.products[preset.demoImg % STATE.products.length].image_url
    : DEMO_STOCK_IMAGES[preset.demoImg % DEMO_STOCK_IMAGES.length];
  STATE.editor.slots = [{
    ...rect, offX: 0.5, offY: 0.5, zoom: 1,
    img: demoImg, mrp: preset.mrp || '', offerPrice: preset.offerPrice || ''
  }];
  STATE.editor.stickers = (preset.badges || []).map(b => {
    const bp = BADGE_PRESETS.find(x => x.id === b.presetId) || BADGE_PRESETS[0];
    return {
      id: uid(), badge: true, badgeId: b.presetId,
      shape: bp.shape, lines: [...bp.lines], bg: bp.bg, fg: bp.fg,
      x: b.x, y: b.y, scale: b.scale || 1, rotation: b.rotation || 0
    };
  });
  enterEditor();
  toast(preset.title + ' template loaded — tap the photo to replace it!');
}
function renderSingleProductRow() {
  const row = document.getElementById('singleProductRow'); if (!row) return;
  row.innerHTML = SINGLE_PRODUCT_PRESETS.map(p => `
    <div class="tcard" onclick="startSingleProductPoster('${p.id}')">
      <div class="thumb" style="background-image:url('${(STATE.products && STATE.products.length ? STATE.products[p.demoImg % STATE.products.length].image_url : DEMO_STOCK_IMAGES[p.demoImg % DEMO_STOCK_IMAGES.length])}');">
        <span class="badge">1 PHOTO</span>
        <div class="tlabel">${escapeHtml(p.title)}</div>
      </div>
      <div class="meta"><div class="cat">Single product template</div>
        <button class="use-btn" onclick="event.stopPropagation();startSingleProductPoster('${p.id}')">Use Template</button>
      </div>
    </div>
  `).join('');
}
function exitEditor() { goto('marketplace'); }

function onFieldInput(key, value) {
  if (!inlineEditHistoryPushed) { pushHistory(); inlineEditHistoryPushed = true; }
  STATE.editor[key] = value; renderPoster();
}
function renderMlQuick() {
  document.getElementById('mlQuick').innerHTML = ML_PHRASES.map(p => `<div class="ml-chip" onclick="insertMl('${p}')">${p}</div>`).join('');
}
function insertMl(phrase) {
  pushHistory();
  STATE.editor.headline = phrase;
  document.getElementById('fHeadline').value = phrase;
  renderPoster();
}
function renderEnQuick() {
  const el = document.getElementById('enQuick'); if (!el) return;
  el.innerHTML = EN_PHRASES.map(p => `<div class="ml-chip" onclick="insertEn('${p}')">${p}</div>`).join('');
}
function insertEn(phrase) {
  pushHistory();
  STATE.editor.headline = phrase;
  document.getElementById('fHeadline').value = phrase;
  renderPoster();
}

let historyStack = [], redoStack = [];
function snapshotEditor() { const c = JSON.parse(JSON.stringify(STATE.editor)); delete c._selectedSticker; delete c._selectedText; return c; }
function pushHistory() { if (!STATE.editor) return; historyStack.push(snapshotEditor()); if (historyStack.length > 30) historyStack.shift(); redoStack = []; updateUndoRedoButtons(); }
function updateUndoRedoButtons() { document.getElementById('undoBtn').disabled = !historyStack.length; document.getElementById('redoBtn').disabled = !redoStack.length; }
function undoEdit() { if (!historyStack.length) return; redoStack.push(snapshotEditor()); STATE.editor = historyStack.pop(); ensureTexts(STATE.editor); refreshEditorUI(); updateUndoRedoButtons(); renderPoster(); }
function redoEdit() { if (!redoStack.length) return; historyStack.push(snapshotEditor()); STATE.editor = redoStack.pop(); ensureTexts(STATE.editor); refreshEditorUI(); updateUndoRedoButtons(); renderPoster(); }
function refreshEditorUI() {
  const ed = STATE.editor;
  document.getElementById('editorTitle').textContent = ed.title;
  document.getElementById('fShopName').value = ed.shopName; document.getElementById('fHeadline').value = ed.headline;
  document.getElementById('fDateRange').value = ed.dateRange; document.getElementById('fPrice').value = ed.price;
  document.getElementById('fDiscount').value = ed.discount; document.getElementById('fWhatsapp').value = ed.whatsapp;
  document.getElementById('fAddress').value = ed.address;
  document.getElementById('logoUpload').innerHTML = ed.logo ? `<img src="${ed.logo}">` : '➕';
  renderSlotGrid(); renderColorSwatches(); renderTextColorSwatches(); renderPillColorSwatches(); renderProductColorSwatches(); renderBorderlessToggle(); renderFontChips(); renderLayoutChips(); renderStickerControls(); renderElementControls(); renderTextControls(); renderTextLayerChips();
}

let pendingSlotIndex = null;
function renderSlotGrid() {
  const ed = STATE.editor;
  document.getElementById('slotGrid').innerHTML = ed.slots.map((s, i) => `
    <div class="slot-thumb ${ed._selectedSlot === i ? 'selected' : ''}" onclick="openSlotEditor(${i})">${s.img ? `<img src="${s.img}">` : '➕'}</div>`).join('');
}
function selectSlot(i) { pendingSlotIndex = i; STATE.editor._selectedSlot = i; renderSlotGrid(); document.getElementById('fileInput').click(); }
function handleFileSelect(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    if (pendingSlotIndex !== null) {
      pushHistory();
      STATE.editor.slots[pendingSlotIndex].img = ev.target.result;
      STATE.editor.slots[pendingSlotIndex].imgOriginal = null;
      STATE.editor.slots[pendingSlotIndex].offX = 0.5; STATE.editor.slots[pendingSlotIndex].offY = 0.5;
      renderSlotGrid(); renderPoster();
      if (document.getElementById('sheetSlotEdit').classList.contains('show')) openSlotEditor(pendingSlotIndex);
    }
  };
  reader.readAsDataURL(file); e.target.value = '';
}
function openSlotEditor(i) {
  pendingSlotIndex = i; STATE.editor._selectedSlot = i; renderSlotGrid();
  const s = STATE.editor.slots[i];
  document.getElementById('slotEditPreview').innerHTML = s.img ? `<img src="${s.img}">` : '➕';
  document.getElementById('slotMrp').value = s.mrp || ''; document.getElementById('slotOfferPrice').value = s.offerPrice || '';
  document.getElementById('slotLibraryGrid').innerHTML = STATE.products.length ? STATE.products.map(p => `
    <div class="sticker-item" onclick="applyProductPhoto('${p.id}')" title="${escapeHtml(p.name)}"><img src="${p.image_url}"></div>`).join('')
    : `<p style="font-size:12px;color:var(--muted);grid-column:1/-1;">No product photos in the library yet.</p>`;
  const hasPrice = !!(s.mrp || s.offerPrice);
  document.getElementById('priceBoxFieldWrap').style.display = hasPrice ? 'block' : 'none';
  document.getElementById('addPriceBoxBtn').textContent = hasPrice ? '🗑 Remove Price Box' : '➕ Add Price Box';
  const hasName = !!(s.offerText && s.offerText.trim());
  document.getElementById('slotOfferText').value = s.offerText || '';
  document.getElementById('productNameFieldWrap').style.display = hasName ? 'block' : 'none';
  document.getElementById('addProductNameBtn').textContent = hasName ? '🗑 Remove Product Name' : '➕ Add Product Name';
  slotOfferTextHistoryPushed = false;
  slotPriceHistoryPushed = false;
  renderPriceStyleChips();
  renderMrpBoxColorSwatches();
  renderOfferBoxColorSwatches();
  renderProductNameBoxColorSwatches();
  renderBgRemoveControls();
  openSheet('sheetSlotEdit');
}
// Price Box (MRP + Offer Price) stays hidden until asked for, same pattern as Product Name —
// tap to reveal and type, tap again (once showing) to remove and clear both fields.
let slotPriceHistoryPushed = false;
function togglePriceBoxField() {
  if (pendingSlotIndex === null) return;
  const wrap = document.getElementById('priceBoxFieldWrap');
  const btn = document.getElementById('addPriceBoxBtn');
  const s = STATE.editor.slots[pendingSlotIndex];
  const showing = wrap.style.display !== 'none';
  if (showing) {
    pushHistory();
    s.mrp = ''; s.offerPrice = '';
    document.getElementById('slotMrp').value = ''; document.getElementById('slotOfferPrice').value = '';
    wrap.style.display = 'none';
    btn.textContent = '➕ Add Price Box';
    renderSlotGrid(); renderPoster();
  } else {
    wrap.style.display = 'block';
    btn.textContent = '🗑 Remove Price Box';
    slotPriceHistoryPushed = false;
    renderMrpBoxColorSwatches(); renderOfferBoxColorSwatches();
    setTimeout(() => document.getElementById('slotMrp').focus(), 50);
  }
}
function onSlotPriceFieldInput() {
  if (pendingSlotIndex === null) return;
  if (!slotPriceHistoryPushed) { pushHistory(); slotPriceHistoryPushed = true; }
  const s = STATE.editor.slots[pendingSlotIndex];
  s.mrp = document.getElementById('slotMrp').value.trim();
  s.offerPrice = document.getElementById('slotOfferPrice').value.trim();
  renderSlotGrid(); renderPoster();
}
// Reuses the same solid-color palette as Shapes/Badges for consistency across the editor.
function renderMrpBoxColorSwatches() {
  const row = document.getElementById('mrpBoxColorSwatches'); if (!row || pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex]; const current = s.mrpColor || '#FFD23C';
  row.innerHTML = SHAPE_COLOR_CHOICES.concat(['#FFD23C']).map(c => `<div class="swatch ${current === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setMrpBoxColor('${c}')"></div>`).join('');
}
function setMrpBoxColor(color) { if (pendingSlotIndex === null) return; pushHistory(); STATE.editor.slots[pendingSlotIndex].mrpColor = color; renderPoster(); renderMrpBoxColorSwatches(); }
function renderOfferBoxColorSwatches() {
  const row = document.getElementById('offerBoxColorSwatches'); if (!row || pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex]; const current = s.offerColor || '#E1273B';
  row.innerHTML = SHAPE_COLOR_CHOICES.concat(['#E1273B']).map(c => `<div class="swatch ${current === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setOfferBoxColor('${c}')"></div>`).join('');
}
function setOfferBoxColor(color) { if (pendingSlotIndex === null) return; pushHistory(); STATE.editor.slots[pendingSlotIndex].offerColor = color; renderPoster(); renderOfferBoxColorSwatches(); }
function renderProductNameBoxColorSwatches() {
  const row = document.getElementById('productNameBoxColorSwatches'); if (!row || pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex]; const current = s.productNameColor || '';
  row.innerHTML = SHAPE_COLOR_CHOICES.map(c => `<div class="swatch ${current === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setProductNameBoxColor('${c}')"></div>`).join('');
}
function setProductNameBoxColor(color) { if (pendingSlotIndex === null) return; pushHistory(); STATE.editor.slots[pendingSlotIndex].productNameColor = color; renderPoster(); renderProductNameBoxColorSwatches(); }
// Product Name stays hidden until asked for — tapping the button reveals the field to type
// into; tapping it again (once a name is showing) removes the label and clears the text.
let slotOfferTextHistoryPushed = false;
function toggleProductNameField() {
  if (pendingSlotIndex === null) return;
  const wrap = document.getElementById('productNameFieldWrap');
  const btn = document.getElementById('addProductNameBtn');
  const s = STATE.editor.slots[pendingSlotIndex];
  const showing = wrap.style.display !== 'none';
  if (showing) {
    pushHistory();
    s.offerText = '';
    document.getElementById('slotOfferText').value = '';
    wrap.style.display = 'none';
    btn.textContent = '➕ Add Product Name';
    renderPoster();
  } else {
    wrap.style.display = 'block';
    btn.textContent = '🗑 Remove Product Name';
    slotOfferTextHistoryPushed = false;
    renderProductNameBoxColorSwatches();
    setTimeout(() => document.getElementById('slotOfferText').focus(), 50);
  }
}
function onSlotOfferTextInput(value) {
  if (pendingSlotIndex === null) return;
  if (!slotOfferTextHistoryPushed) { pushHistory(); slotOfferTextHistoryPushed = true; }
  STATE.editor.slots[pendingSlotIndex].offerText = value;
  renderPoster();
}
function applyProductPhoto(productId) {
  const p = STATE.products.find(p => p.id === productId); if (!p || pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.img = p.image_url; s.imgOriginal = null; s.offX = 0.5; s.offY = 0.5;
  if (!s.mrp && p.mrp) s.mrp = String(p.mrp);
  if (!s.offerPrice && p.offer_price) s.offerPrice = String(p.offer_price);
  document.getElementById('slotMrp').value = s.mrp || '';
  document.getElementById('slotOfferPrice').value = s.offerPrice || '';
  if (s.mrp || s.offerPrice) {
    document.getElementById('priceBoxFieldWrap').style.display = 'block';
    document.getElementById('addPriceBoxBtn').textContent = '🗑 Remove Price Box';
    renderMrpBoxColorSwatches(); renderOfferBoxColorSwatches();
  }
  document.getElementById('slotEditPreview').innerHTML = `<img src="${s.img}">`;
  renderSlotGrid(); renderPoster(); renderBgRemoveControls();
  toast('Product photo applied');
}
// Background removal: shows a "Remove Background" button once a photo is picked (from
// device or the product library), and an "Undo" button after it's been applied.
function renderBgRemoveControls() {
  const box = document.getElementById('bgRemoveControls'); if (!box || pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex];
  if (!s || !s.img) { box.innerHTML = ''; return; }
  box.innerHTML = s.imgOriginal
    ? `<button class="btn btn-outline btn-sm" style="flex:1;" onclick="undoBackgroundRemoval()">↩️ Undo Background Removal</button>`
    : `<button class="btn btn-outline btn-sm" style="flex:1;" id="removeBgBtn" onclick="removeSlotBackground()">🪄 Remove Background</button>`;
}
async function removeSlotBackground() {
  if (pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex];
  if (!s.img) return;
  const btn = document.getElementById('removeBgBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Removing background…'; }
  try {
    const resultUrl = await stripBackgroundFromImage(s.img);
    pushHistory();
    s.imgOriginal = s.img;
    s.img = resultUrl;
    document.getElementById('slotEditPreview').innerHTML = `<img src="${s.img}">`;
    renderSlotGrid(); renderPoster(); renderBgRemoveControls();
    toast('Background removed — works best on plain/white backgrounds');
  } catch (err) {
    toast('Could not remove the background from this photo', true);
    renderBgRemoveControls();
  }
}
function undoBackgroundRemoval() {
  if (pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex];
  if (!s.imgOriginal) return;
  pushHistory();
  s.img = s.imgOriginal;
  s.imgOriginal = null;
  document.getElementById('slotEditPreview').innerHTML = `<img src="${s.img}">`;
  renderSlotGrid(); renderPoster(); renderBgRemoveControls();
  toast('Original photo restored');
}
// Loads `src`, samples the background color from the image's outer border, then removes
// only the pixels reachable from that border through a continuous path of matching color
// (flood fill) — not every pixel in the photo that happens to share that color. This is
// what protects interior details like white text or highlights on the product itself: they
// aren't connected to the outer background region, so a plain "remove pixels near this
// color" pass would wrongly erase them, but a flood fill from the edges won't touch them.
function stripBackgroundFromImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const maxDim = 1200;
        const scale = Math.min(1, maxDim / Math.max(im.width, im.height));
        const w = Math.max(1, Math.round(im.width * scale)), h = Math.max(1, Math.round(im.height * scale));
        const off = document.createElement('canvas'); off.width = w; off.height = h;
        const octx = off.getContext('2d');
        octx.drawImage(im, 0, 0, w, h);
        const imgData = octx.getImageData(0, 0, w, h);
        const d = imgData.data;
        const n = w * h;

        // Sample the background color from the full border perimeter (more reliable than
        // just the 4 corners when the subject sits close to one edge).
        let sr = 0, sg = 0, sb = 0, count = 0;
        const addSample = (x, y) => { const i = (y * w + x) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; count++; };
        for (let x = 0; x < w; x++) { addSample(x, 0); addSample(x, h - 1); }
        for (let y = 0; y < h; y++) { addSample(0, y); addSample(w - 1, y); }
        const avgR = sr / count, avgG = sg / count, avgB = sb / count;
        const colorDist = (i) => { const dr = d[i] - avgR, dg = d[i + 1] - avgG, db = d[i + 2] - avgB; return Math.sqrt(dr * dr + dg * dg + db * db); };

        const threshold = 46;
        const visited = new Uint8Array(n);
        const removeMask = new Uint8Array(n);
        const stack = [];
        const tryPush = (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return;
          const p = y * w + x;
          if (visited[p]) return;
          visited[p] = 1;
          if (colorDist(p * 4) < threshold) { removeMask[p] = 1; stack.push(p); }
        };
        for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
        for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
        while (stack.length) {
          const p = stack.pop();
          const x = p % w, y = (p / w) | 0;
          tryPush(x + 1, y); tryPush(x - 1, y); tryPush(x, y + 1); tryPush(x, y - 1);
        }

        // Soften just the cut edge (pixels touching a removed pixel) so it isn't jagged —
        // this deliberately does NOT touch similar-colored pixels elsewhere in the photo.
        const feather = 30;
        for (let p = 0; p < n; p++) {
          if (removeMask[p]) { d[p * 4 + 3] = 0; continue; }
          const i = p * 4;
          const dist = colorDist(i);
          if (dist < threshold + feather) {
            const x = p % w, y = (p / w) | 0;
            let nearRemoved = false;
            if (x + 1 < w && removeMask[p + 1]) nearRemoved = true;
            else if (x > 0 && removeMask[p - 1]) nearRemoved = true;
            else if (y + 1 < h && removeMask[p + w]) nearRemoved = true;
            else if (y > 0 && removeMask[p - w]) nearRemoved = true;
            if (nearRemoved) d[i + 3] = Math.round(d[i + 3] * ((dist - threshold) / feather));
          }
        }

        octx.putImageData(imgData, 0, 0);
        resolve(off.toDataURL('image/png'));
      } catch (err) { reject(err); }
    };
    im.onerror = () => reject(new Error('image load failed'));
    im.src = src;
  });
}
function saveSlotPrices() {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  if (document.getElementById('priceBoxFieldWrap').style.display !== 'none') {
    s.mrp = document.getElementById('slotMrp').value.trim(); s.offerPrice = document.getElementById('slotOfferPrice').value.trim();
  }
  if (document.getElementById('productNameFieldWrap').style.display !== 'none') {
    s.offerText = document.getElementById('slotOfferText').value.trim();
  }
  renderSlotGrid(); renderPoster(); closeSheets(); toast('Photo details saved');
}
function deleteSlotContent() {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.img = null; s.imgOriginal = null; s.mrp = ''; s.offerPrice = ''; s.offerText = '';
  s.mrpColor = null; s.offerColor = null; s.productNameColor = null;
  renderSlotGrid(); renderPoster(); closeSheets(); toast('Photo removed');
}
// Deletes the photo box itself (not just its content) — the layout loses this box entirely,
// unlike "Remove Photo" which only clears the image/price and keeps an empty box.
function deleteSlotBox() {
  if (pendingSlotIndex === null) return;
  if (STATE.editor.slots.length <= 1) { toast('At least one photo box is needed', true); return; }
  pushHistory();
  STATE.editor.slots.splice(pendingSlotIndex, 1);
  pendingSlotIndex = null;
  STATE.editor._selectedSlot = null;
  renderSlotGrid(); renderPoster(); closeSheets();
  toast('Photo box deleted');
}
function adjustSlotZoom(delta) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.zoom = Math.min(2.5, Math.max(0.5, (s.zoom || 1) + delta));
  renderPoster();
  toast('Photo size adjusted');
}
// Grows/shrinks the photo box itself (not just the zoom of the image inside it) — symmetric
// about its own center, so widening it expands equally to the left and right (and taller
// expands equally up and down), matching "രണ്ട് സൈഡിലേക്കും" (to both sides).
function resizeSlotBox(dim, factor) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  if (dim === 'w') {
    const newW = Math.max(0.08, Math.min(1, (s.w || 0.3) * factor));
    s.x = Math.max(0, Math.min(1 - newW, s.x + (s.w - newW) / 2));
    s.w = newW;
  } else {
    const newH = Math.max(0.08, Math.min(1, (s.h || 0.3) * factor));
    s.y = Math.max(0, Math.min(1 - newH, s.y + (s.h - newH) / 2));
    s.h = newH;
  }
  renderSlotGrid(); renderPoster();
}
// Moves just the MRP/offer-price tag away from its default top-left corner of the photo —
// independent of the photo box itself.
function movePriceTag(dx, dy) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.priceOffX = Math.max(-0.5, Math.min(0.7, (s.priceOffX || 0) + dx));
  s.priceOffY = Math.max(-0.3, Math.min(0.8, (s.priceOffY || 0) + dy));
  renderPoster();
}
function resizePriceTag(factor) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.priceScale = Math.min(2.5, Math.max(0.4, (s.priceScale || 1) * factor));
  renderPoster();
}
const PRICE_TAG_STYLES = [
  { id: 'rect', label: '▭ Rectangle' },
  { id: 'round', label: '⬭ Round' }
];
function renderPriceStyleChips() {
  const row = document.getElementById('priceStyleChips'); if (!row || pendingSlotIndex === null) return;
  const s = STATE.editor.slots[pendingSlotIndex];
  const current = s.priceStyle || 'rect';
  row.innerHTML = PRICE_TAG_STYLES.map(p => `<div class="font-chip ${current === p.id ? 'active' : ''}" onclick="setPriceStyle('${p.id}')">${p.label}</div>`).join('');
}
function setPriceStyle(style) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  STATE.editor.slots[pendingSlotIndex].priceStyle = style;
  renderPriceStyleChips(); renderPoster();
}
// Moves the automatic "% OFF" circle badge (computed from MRP vs offer price) — independent
// of the MRP/offer-price tag boxes and the photo box itself.
function movePctBadge(dx, dy) {
  if (pendingSlotIndex === null) return;
  pushHistory();
  const s = STATE.editor.slots[pendingSlotIndex];
  s.pctOffX = Math.max(-0.8, Math.min(0.3, (s.pctOffX || 0) + dx));
  s.pctOffY = Math.max(-0.3, Math.min(0.8, (s.pctOffY || 0) + dy));
  renderPoster();
}

function handleLogoSelect(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { pushHistory(); STATE.editor.logo = ev.target.result; document.getElementById('logoUpload').innerHTML = `<img src="${ev.target.result}">`; renderPoster(); };
  reader.readAsDataURL(file); e.target.value = '';
}
function removeLogo() { pushHistory(); STATE.editor.logo = null; STATE.editor.logoScale = 1; document.getElementById('logoUpload').innerHTML = '➕'; renderPoster(); }
function resizeLogoDim(dim, factor) {
  const ed = STATE.editor;
  if (!ed || !ed.logo) { toast('ആദ്യം ഒരു ലോഗോ അപ്‌ലോഡ് ചെയ്യുക', true); return; }
  pushHistory();
  if (dim === 'w') {
    ed.logoWidthScale = Math.min(9, Math.max(0.3, (ed.logoWidthScale !== undefined ? ed.logoWidthScale : 1) * factor));
  } else if (dim === 'h') {
    ed.logoHeightScale = Math.min(9, Math.max(0.3, (ed.logoHeightScale !== undefined ? ed.logoHeightScale : 1) * factor));
  }
  renderPoster();
}
function moveLogo(dx, dy) {
  const ed = STATE.editor;
  if (!ed || !ed.logo) return;
  pushHistory();
  ed.logoX = Math.max(0, Math.min(0.9, (ed.logoX !== undefined ? ed.logoX : 0.05) + dx));
  ed.logoY = Math.max(0, Math.min(0.9, (ed.logoY !== undefined ? ed.logoY : 0.04) + dy));
  renderPoster();
}

function renderColorSwatches() {
  document.getElementById('colorSwatches').innerHTML = THEME_COLORS.map(c => `<div class="swatch ${(STATE.editor.themeType === 'solid' && STATE.editor.theme === c) ? 'active' : ''}" style="background:${c}" onclick="setTheme('${c}')"></div>`).join('')
    + GRADIENT_PRESETS.map(g => `<div class="swatch ${(STATE.editor.themeType === 'gradient' && STATE.editor.themeGradient[0] === g.colors[0]) ? 'active' : ''}" style="background:linear-gradient(135deg,${g.colors[0]},${g.colors[1]})" onclick="setThemeGradient('${g.id}')"></div>`).join('');
}
function setTheme(c) { pushHistory(); STATE.editor.theme = c; STATE.editor.themeType = 'solid'; renderColorSwatches(); renderPoster(); }
function setThemeGradient(id) { const g = GRADIENT_PRESETS.find(g => g.id === id); if (!g) return; pushHistory(); STATE.editor.themeGradient = g.colors; STATE.editor.themeType = 'gradient'; renderColorSwatches(); renderPoster(); }
function renderFontChips() { document.getElementById('fontChips').innerHTML = FONT_OPTIONS.map(f => `<div class="font-chip ${STATE.editor.font === f.id ? 'active' : ''}" style="font-family:${f.css}" onclick="setFont('${f.id}')">${f.label}</div>`).join(''); }
function setFont(id) { pushHistory(); STATE.editor.font = id; renderFontChips(); renderPoster(); }

function renderLayoutChips() {
  const currentLayout = STATE.editor.layout || '4';
  const currentType = STATE.editor.layoutType || 'grid';
  document.getElementById('layoutChips').innerHTML = `
      <div class="font-chip ${currentType === 'layout_loot' ? 'active' : ''}" onclick="setLayoutCustom('layout_loot', '15')">🟩 1. Weekend Loot Style</div>
    <div class="font-chip ${currentType === 'layout_fiesta' ? 'active' : ''}" onclick="setLayoutCustom('layout_fiesta', '15')">🟣 2. Eid Fiesta Style</div>
    <div class="font-chip ${currentType === 'layout_buymore' ? 'active' : ''}" onclick="setLayoutCustom('layout_buymore', '8')">🔴 3. Buy More Style</div>
    <div class="font-chip ${currentType === 'layout_onam' ? 'active' : ''}" onclick="setLayoutCustom('layout_onam', '8')">🟡 4. Onam Special Style</div>
    <div class="font-chip ${currentLayout === '4' && currentType === 'combo' ? 'active' : ''}" onclick="setLayoutCombo('4')">🔥 Combo Layout (1+3)</div>
    <div class="font-chip ${currentLayout === '1' ? 'active' : ''}" onclick="setLayout('1')">1 Photo</div>
    <div class="font-chip ${currentLayout === '2' ? 'active' : ''}" onclick="setLayout('2')">2 Photos</div>
    <div class="font-chip ${currentLayout === '4' && currentType === 'grid' ? 'active' : ''}" onclick="setLayout('4')">4 Photos</div>
    <div class="font-chip ${currentLayout === '6' ? 'active' : ''}" onclick="setLayout('6')">6 Photos</div>
    <div class="font-chip ${currentLayout === '9' ? 'active' : ''}" onclick="setLayout('9')">9 Photos</div>
    <div class="font-chip ${currentLayout === '12' ? 'active' : ''}" onclick="setLayout('12')">12 Photos</div>
    <div class="font-chip ${currentLayout === '20' ? 'active' : ''}" onclick="setLayout('20')">20 Photos</div>
  `;
}
function setLayoutCustom(layoutName, count) {
  pushHistory(); 
  STATE.editor.layout = count;
  STATE.editor.layoutType = layoutName;
  const existing = STATE.editor.slots, rects = getSlotRects(count, layoutName);
  STATE.editor.slots = rects.map((r, i) => ({ ...r, img: existing[i] ? existing[i].img : null, mrp: existing[i] ? existing[i].mrp : '', offerPrice: existing[i] ? existing[i].offerPrice : '', offerText: existing[i] ? existing[i].offerText : '', offX: 0.5, offY: 0.5, zoom: 1 }));
  renderLayoutChips(); renderSlotGrid(); renderPoster();
}
function setLayout(o) {
  pushHistory(); 
  STATE.editor.layout = o;
  STATE.editor.layoutType = 'grid';
  const existing = STATE.editor.slots, rects = getSlotRects(o, 'grid');
  STATE.editor.slots = rects.map((r, i) => ({ ...r, img: existing[i] ? existing[i].img : null, mrp: existing[i] ? existing[i].mrp : '', offerPrice: existing[i] ? existing[i].offerPrice : '', offerText: existing[i] ? existing[i].offerText : '', offX: 0.5, offY: 0.5, zoom: 1 }));
  renderLayoutChips(); renderSlotGrid(); renderPoster();
}
function setLayoutCombo(o) {
  pushHistory(); 
  STATE.editor.layout = o;
  STATE.editor.layoutType = 'combo';
  const existing = STATE.editor.slots, rects = getSlotRects(o, 'combo');
  STATE.editor.slots = rects.map((r, i) => ({ ...r, img: existing[i] ? existing[i].img : null, mrp: existing[i] ? existing[i].mrp : '', offerPrice: existing[i] ? existing[i].offerPrice : '', offerText: existing[i] ? existing[i].offerText : '', offX: 0.5, offY: 0.5, zoom: 1 }));
  renderLayoutChips(); renderSlotGrid(); renderPoster();
}

function renderStickerLibrary() {
  const builtinHtml = BUILTIN_STICKERS.map(group => `
    <div style="grid-column:1/-1;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 2px;">${group.cat}</div>
    ${group.items.map(emoji => `<div class="sticker-item" onclick="addEmojiSticker('${emoji}')" style="display:flex;align-items:center;justify-content:center;font-size:22px;">${emoji}</div>`).join('')}
  `).join('');
  const adminHtml = STATE.stickers.length ? `
    <div style="grid-column:1/-1;font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:8px 0 2px;">from your admin</div>
    ${STATE.stickers.map(s => `<div class="sticker-item" onclick="addImageSticker('${s.id}','${s.image_url}')"><img src="${s.image_url}"></div>`).join('')}
  ` : '';
  document.getElementById('stickerLibraryGrid').innerHTML = builtinHtml + adminHtml;
}
function renderBadgeLibrary() {
  const grid = document.getElementById('badgeLibraryGrid'); if (!grid) return;
  const shapeRadius = { burst: '10%', ribbon: '8px', circle: '50%' };
  grid.innerHTML = BADGE_PRESETS.map(b => `
    <div class="sticker-item" onclick="addBadgeSticker('${b.id}')" style="display:flex;align-items:center;justify-content:center;background:${b.bg};color:${b.fg};border-radius:${shapeRadius[b.shape]};font-weight:900;font-size:10px;line-height:1.15;text-align:center;font-family:'Anton',sans-serif;padding:4px;">
      ${b.lines.join('<br>')}
    </div>
  `).join('');
}
let selectedShapeColor = '#152420';
function renderShapeLibrary() {
  const swatchRow = document.getElementById('shapeColorSwatches');
  if (swatchRow) {
    swatchRow.innerHTML = SHAPE_COLOR_CHOICES.map(c => `<div class="swatch ${selectedShapeColor === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setSelectedShapeColor('${c}')"></div>`).join('');
  }
  const grid = document.getElementById('shapeLibraryGrid'); if (!grid) return;
  grid.innerHTML = SHAPE_PRESETS.map(sh => `
    <div class="sticker-item" onclick="addShapeElement('${sh.id}')" style="display:flex;align-items:center;justify-content:center;background:#fff;">
      <img src="${shapePreviewDataUrl(sh.id, selectedShapeColor)}" style="width:70%;height:70%;object-fit:contain;" alt="${escapeHtml(sh.label || sh.id)}">
    </div>
  `).join('');
}
// Renders any shape kind onto a small offscreen canvas using the exact same shapePath() the
// poster itself uses, so every library thumbnail — old or newly added — always matches what
// actually gets drawn, without hand-maintaining a separate CSS clip-path per shape.
const _shapePreviewCache = {};
function shapePreviewDataUrl(kind, color) {
  const cacheKey = kind + '|' + color;
  if (_shapePreviewCache[cacheKey]) return _shapePreviewCache[cacheKey];
  const size = 72;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const pctx = c.getContext('2d');
  pctx.translate(size / 2, size / 2);
  const pad = size * 0.82;
  shapePath(pctx, kind, pad, pad);
  pctx.fillStyle = color;
  pctx.fill(kind === 'ring' ? 'evenodd' : 'nonzero');
  const url = c.toDataURL();
  _shapePreviewCache[cacheKey] = url;
  return url;
}
function setSelectedShapeColor(color) { selectedShapeColor = color; renderShapeLibrary(); }
function addShapeElement(kind) {
  pushHistory();
  if (!STATE.editor.stickers) STATE.editor.stickers = [];
  const id = uid();
  STATE.editor.stickers.push({ id, isShape: true, kind, color: selectedShapeColor, x: 0.5, y: 0.5, w: 0.28, h: 0.2, rotation: 0 });
  STATE.editor._selectedSticker = id;
  renderPoster(); renderElementControls(); toast('Shape added (behind photo & text)');
}
function addEmojiSticker(emoji) {
  pushHistory();
  if (!STATE.editor.stickers) STATE.editor.stickers = [];
  const id = uid();
  STATE.editor.stickers.push({ id, emoji, x: 0.5, y: 0.5, scale: 1, rotation: 0 });
  STATE.editor._selectedSticker = id;
  renderPoster(); renderStickerControls(); toast('Sticker added (behind text)');
}
function addImageSticker(assetId, imageUrl) {
  pushHistory();
  if (!STATE.editor.stickers) STATE.editor.stickers = [];
  const id = uid();
  STATE.editor.stickers.push({ id, assetId, imageUrl, x: 0.5, y: 0.5, scale: 1, rotation: 0 });
  STATE.editor._selectedSticker = id;
  renderPoster(); renderStickerControls(); toast('Sticker added (behind text)');
}
function addBadgeSticker(badgeId) {
  pushHistory();
  if (!STATE.editor.stickers) STATE.editor.stickers = [];
  const preset = BADGE_PRESETS.find(b => b.id === badgeId) || BADGE_PRESETS[0];
  const id = uid();
  STATE.editor.stickers.push({
    id, badge: true, badgeId,
    shape: preset.shape, lines: [...preset.lines], bg: preset.bg, fg: preset.fg,
    x: 0.5, y: 0.5, scale: 1.3, rotation: 0
  });
  STATE.editor._selectedSticker = id;
  badgeTextHistoryPushed = false;
  renderPoster(); renderStickerControls(); toast('Badge added (behind text)');
}
function getSelectedSticker() { if (!STATE.editor?._selectedSticker) return null; return STATE.editor.stickers.find(s => s.id === STATE.editor._selectedSticker) || null; }
function selectStickerByIdx(idx) {
  const st = STATE.editor.stickers[idx]; if (!st) return;
  deselectText(); badgeTextHistoryPushed = false;
  STATE.editor._selectedSticker = st.id;
  renderPoster();
  if (st.isShape) { renderElementControls(); setEditorTab('elements'); }
  else { renderStickerControls(); setEditorTab('stickers'); }
}
function deselectSticker() { if (STATE.editor?._selectedSticker) { STATE.editor._selectedSticker = null; renderPoster(); renderStickerControls(); renderElementControls(); } }
const BADGE_COLOR_CHOICES = ['#8C3AA8', '#DC2626', '#059669', '#F59E0B', '#EA580C', '#B91C1C', '#0EA5E9', '#111827', '#7C3AED', '#DB2777', '#152420', '#FFFFFF'];
function renderStickerControls() {
  const st = getSelectedSticker(); const box = document.getElementById('stickerControls'); if (!box) return;
  if (!st || st.isShape) { box.innerHTML = `<p style="font-size:12px;color:var(--muted);">Tap a sticker on the poster to select it.</p>`; return; }
  const commonButtons = `
    <button class="btn btn-outline btn-sm" onclick="resizeSticker(1.15)">🔍+ Bigger</button>
    <button class="btn btn-outline btn-sm" onclick="resizeSticker(0.87)">🔍− Smaller</button>
    <button class="btn btn-outline btn-sm" onclick="rotateSticker(-15)">↺ Rotate Left</button>
    <button class="btn btn-outline btn-sm" onclick="rotateSticker(15)">↻ Rotate Right</button>
    <button class="btn btn-outline btn-sm" onclick="duplicateSticker()">📄 Duplicate</button>
    <button class="btn btn-outline btn-sm" style="border-color:var(--coral);color:var(--coral);" onclick="deleteSticker()">🗑 Delete</button>`;
  if (st.badge) {
    // Badges are fully editable: their own text and color, not just position/size — every
    // badge you add can be changed independently, it doesn't stay locked to the preset.
    const currentText = (st.lines || []).join(' / ');
    box.innerHTML = `
      <div class="field" style="width:100%;margin-bottom:0;"><label>Badge Text (use / for a new line)</label>
        <input type="text" value="${escapeHtml(currentText)}" oninput="updateBadgeText(this.value)"></div>
      <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;width:100%;margin:10px 0 6px;">BADGE COLOR</label>
      <div class="swatch-row" style="width:100%;margin-bottom:8px;">
        ${BADGE_COLOR_CHOICES.map(c => `<div class="swatch ${st.bg === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setBadgeColor('${c}')"></div>`).join('')}
      </div>
      <button class="btn btn-outline btn-sm" onclick="setBadgeTextColor(${st.fg === '#ffffff' ? "'#1c1204'" : "'#ffffff'"})">🎨 Toggle Text Color (${st.fg === '#ffffff' ? 'White' : 'Dark'})</button>
      ${commonButtons}`;
  } else {
    box.innerHTML = commonButtons;
  }
}
function updateBadgeText(value) {
  const st = getSelectedSticker(); if (!st || !st.badge) return;
  if (!badgeTextHistoryPushed) { pushHistory(); badgeTextHistoryPushed = true; }
  st.lines = value.split('/').map(s => s.trim()).filter(s => s.length).slice(0, 3);
  if (!st.lines.length) st.lines = [''];
  renderPoster();
}
let badgeTextHistoryPushed = false;
function setBadgeColor(color) { const st = getSelectedSticker(); if (!st || !st.badge) return; pushHistory(); st.bg = color; renderPoster(); renderStickerControls(); }
function setBadgeTextColor(color) { const st = getSelectedSticker(); if (!st || !st.badge) return; pushHistory(); st.fg = color; renderPoster(); renderStickerControls(); }
function resizeSticker(f) { const st = getSelectedSticker(); if (!st) return; pushHistory(); st.scale = Math.min(3, Math.max(0.3, (st.scale || 1) * f)); renderPoster(); }
function rotateSticker(d) { const st = getSelectedSticker(); if (!st) return; pushHistory(); st.rotation = ((st.rotation || 0) + d) % 360; renderPoster(); }
function duplicateSticker() { const st = getSelectedSticker(); if (!st) return; pushHistory(); const copy = { ...st, id: uid(), lines: st.lines ? [...st.lines] : undefined, x: Math.min(1, st.x + 0.06), y: Math.min(1, st.y + 0.06) }; STATE.editor.stickers.push(copy); STATE.editor._selectedSticker = copy.id; renderPoster(); if (copy.isShape) renderElementControls(); else renderStickerControls(); }
function deleteSticker() { const st = getSelectedSticker(); if (!st) return; pushHistory(); STATE.editor.stickers = STATE.editor.stickers.filter(s => s.id !== st.id); STATE.editor._selectedSticker = null; renderPoster(); renderStickerControls(); renderElementControls(); }

// ===== Shape element controls (Elements tab) — independent width & height, plus rotate,
// color and delete, matching "വീതി/നീളം കൂട്ടാനും കുറക്കാനും" (grow/shrink width & height
// separately, not just uniform scale like emoji/badge stickers). =====
function renderElementControls() {
  const st = getSelectedSticker(); const box = document.getElementById('elementControls'); if (!box) return;
  if (!st || !st.isShape) { box.innerHTML = `<p style="font-size:12px;color:var(--muted);">Tap a shape on the poster to select it.</p>`; return; }
  box.innerHTML = `
    <button class="btn btn-outline btn-sm" onclick="resizeShapeWidth(1.15)">↔️+ Wider</button>
    <button class="btn btn-outline btn-sm" onclick="resizeShapeWidth(0.87)">↔️− Narrower</button>
    <button class="btn btn-outline btn-sm" onclick="resizeShapeHeight(1.15)">↕️+ Taller</button>
    <button class="btn btn-outline btn-sm" onclick="resizeShapeHeight(0.87)">↕️− Shorter</button>
    <button class="btn btn-outline btn-sm" onclick="rotateSticker(-15)">↺ Rotate Left</button>
    <button class="btn btn-outline btn-sm" onclick="rotateSticker(15)">↻ Rotate Right</button>
    <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;width:100%;margin:10px 0 6px;">SHAPE COLOR</label>
    <div class="swatch-row" style="width:100%;margin-bottom:8px;">
      ${SHAPE_COLOR_CHOICES.map(c => `<div class="swatch ${st.color === c ? 'active' : ''}" style="background:${c};border:1.5px solid #cbd5e1;" onclick="setShapeColor('${c}')"></div>`).join('')}
    </div>
    <button class="btn btn-outline btn-sm" onclick="duplicateSticker()">📄 Duplicate</button>
    <button class="btn btn-outline btn-sm" style="border-color:var(--coral);color:var(--coral);" onclick="deleteSticker()">🗑 Delete</button>`;
}
function resizeShapeWidth(f) { const st = getSelectedSticker(); if (!st || !st.isShape) return; pushHistory(); st.w = Math.min(0.95, Math.max(0.04, (st.w || 0.28) * f)); renderPoster(); }
function resizeShapeHeight(f) { const st = getSelectedSticker(); if (!st || !st.isShape) return; pushHistory(); st.h = Math.min(0.95, Math.max(0.04, (st.h || 0.2) * f)); renderPoster(); }
function setShapeColor(color) { const st = getSelectedSticker(); if (!st || !st.isShape) return; pushHistory(); st.color = color; renderPoster(); renderElementControls(); }

function getSelectedText() { if (!STATE.editor?._selectedText) return null; return STATE.editor.texts.find(t => t.id === STATE.editor._selectedText) || null; }
function selectTextByIdx(idx) { const t = STATE.editor.texts[idx]; if (!t) return; deselectSticker(); STATE.editor._selectedText = t.id; renderPoster(); renderTextControls(); renderTextLayerChips(); setEditorTab('text'); }
function deselectText() { if (STATE.editor?._selectedText) { STATE.editor._selectedText = null; renderPoster(); renderTextControls(); renderTextLayerChips(); } }
function renderTextLayerChips() {
  const row = document.getElementById('textLayerChips'); if (!row || !STATE.editor) return;
  const ed = STATE.editor;
  row.innerHTML = ed.texts.map(t => `<div class="font-chip ${ed._selectedText === t.id ? 'active' : ''}" style="${t.visible === false ? 'opacity:.45;' : ''}" onclick="toggleSelectOrShowText('${t.id}')">${escapeHtml(textLayerLabel(t.key))}${t.visible === false ? ' (hidden)' : ''}</div>`).join('');
}
function toggleSelectOrShowText(id) {
  const t = STATE.editor.texts.find(x => x.id === id); if (!t) return;
  if (t.visible === false) { pushHistory(); t.visible = true; }
  deselectSticker();
  STATE.editor._selectedText = id;
  renderPoster(); renderTextControls(); renderTextLayerChips();
}
function renderTextControls() {
  const box = document.getElementById('textLayerControls'); if (!box) return;
  const tl = getSelectedText();
  if (!tl) { box.innerHTML = `<p style="font-size:12px;color:var(--muted);">Tap any text on the poster (shop name, headline, price pill, address, etc.) to select it — then move, resize, rotate, bend, edit or delete it.</p>`; return; }
  const curveLabel = tl.key === 'pill' ? '' : `<div style="width:100%;font-size:10.5px;color:var(--muted);margin:2px 0 2px;">BEND: ${tl.curve || 0}${tl.curve ? (tl.curve > 0 ? ' (up)' : ' (down)') : ' (straight)'}</div>`;
  box.innerHTML = `
    <div style="width:100%;font-size:12px;font-weight:700;margin-bottom:6px;">${escapeHtml(textLayerLabel(tl.key))}</div>
    <button class="btn btn-outline btn-sm" onclick="resizeText(1.12)">🔍+ Bigger</button>
    <button class="btn btn-outline btn-sm" onclick="resizeText(0.89)">🔍− Smaller</button>
    <button class="btn btn-outline btn-sm" onclick="rotateText(-10)">↺ Rotate Left</button>
    <button class="btn btn-outline btn-sm" onclick="rotateText(10)">↻ Rotate Right</button>
    ${curveLabel}
    ${tl.key === 'pill' ? '' : `
    <button class="btn btn-outline btn-sm" onclick="curveText(15)">🙂 Bend Up</button>
    <button class="btn btn-outline btn-sm" onclick="curveText(-15)">🙃 Bend Down</button>
    <button class="btn btn-outline btn-sm" onclick="curveText(0, true)">➖ Straighten</button>`}
    <button class="btn btn-outline btn-sm" onclick="openTextInlineEdit(getSelectedText())">✏️ Edit Text</button>
    <button class="btn btn-outline btn-sm" onclick="resetTextPosition()">↩️ Reset Position</button>
    <button class="btn btn-outline btn-sm" style="border-color:var(--coral);color:var(--coral);" onclick="deleteTextLayer()">🗑 Hide / Delete</button>`;
}
function resizeText(f) { const t = getSelectedText(); if (!t) return; pushHistory(); t.scale = Math.min(3, Math.max(0.3, (t.scale || 1) * f)); renderPoster(); }
function rotateText(d) { const t = getSelectedText(); if (!t) return; pushHistory(); t.rotation = ((t.rotation || 0) + d) % 360; renderPoster(); }
function curveText(delta, reset) {
  const t = getSelectedText(); if (!t) return;
  pushHistory();
  t.curve = reset ? 0 : Math.max(-100, Math.min(100, (t.curve || 0) + delta));
  renderPoster(); renderTextControls();
}
function resetTextPosition() {
  const t = getSelectedText(); if (!t) return; pushHistory();
  const def = defaultTextLayers().find(d => d.id === t.id);
  if (def) { t.x = def.x; t.y = def.y; }
  t.rotation = 0; t.scale = 1; t.curve = 0;
  renderPoster(); renderTextControls();
}
function deleteTextLayer() {
  const t = getSelectedText(); if (!t) return; pushHistory();
  t.visible = false; STATE.editor._selectedText = null;
  renderPoster(); renderTextControls(); renderTextLayerChips();
  toast('Text hidden — tap it again in "All Text Layers" to bring it back.');
}
function openTextInlineEdit(tl) {
  if (!tl) return;
  const fieldKey = textLayerFieldKey(tl.key);
  if (!fieldKey) return;
  openInlineEdit(textLayerLabel(tl.key), [{ key: fieldKey, label: textLayerLabel(tl.key) }]);
}

const canvas = document.getElementById('posterCanvas'), ctx = canvas.getContext('2d');
const imgCache = {};
function loadImg(src) {
  return new Promise(resolve => {
    if (!src) { resolve(null); return; }
    if (imgCache[src]) { resolve(imgCache[src]); return; }
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => { imgCache[src] = im; resolve(im); };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}
function hexToRgba(hex, a) { const v = hex.replace('#', ''); const r = parseInt(v.substring(0, 2), 16), g = parseInt(v.substring(2, 4), 16), b = parseInt(v.substring(4, 6), 16); return `rgba(${r},${g},${b},${a})`; }
function shadeColor(hex, percent) { const v = hex.replace('#', ''); let r = parseInt(v.substring(0, 2), 16), g = parseInt(v.substring(2, 4), 16), b = parseInt(v.substring(4, 6), 16); r = Math.min(255, Math.max(0, Math.round(r + (percent / 100) * 255))); g = Math.min(255, Math.max(0, Math.round(g + (percent / 100) * 255))); b = Math.min(255, Math.max(0, Math.round(b + (percent / 100) * 255))); return `rgb(${r},${g},${b})`; }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
// Draws an MRP/price tag box in one of several shapes: 'rect' (default rounded box),
// 'round' (full pill), or 'star' (starburst) — same (x,y,w,h) footprint either way, just
// different silhouette, so text placement math elsewhere doesn't need to change.
function drawPriceBox(ctx, style, x, y, w, h, fillColor) {
  ctx.fillStyle = fillColor;
  if (style === 'round') {
    roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
  } else if (style === 'star') {
    const cx = x + w / 2, cy = y + h / 2, outerR = Math.max(w, h) * 0.62, innerR = outerR * 0.72, spikes = 8;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) { const r = i % 2 === 0 ? outerR : innerR; const a = (Math.PI / spikes) * i - 0.2; const px = cx + Math.sin(a) * r, py = cy - Math.cos(a) * r; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill();
  } else {
    roundRect(ctx, x, y, w, h, 4); ctx.fill();
  }
}
function drawStarburst(ctx, cx, cy, outerR, innerR, spikes, color, label) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.12); ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) { const r = i % 2 === 0 ? outerR : innerR; const a = (Math.PI / spikes) * i; const x = Math.sin(a) * r, y = -Math.cos(a) * r; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.closePath(); ctx.fillStyle = color; ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3; ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `900 ${Math.round(innerR * 0.62)}px sans-serif`; ctx.fillText(label, 0, 2); ctx.restore();
}
// Draws a bold "sale poster" style badge sticker at the current canvas origin (0,0), sized
// to fit within `size` — the burst/circle/ribbon shapes seen in cashback/sale/black-friday
// style posters, with real crisp text instead of an emoji.
function drawBadgeSticker(ctx, st, size) {
  const preset = BADGE_PRESETS.find(b => b.id === st.badgeId) || BADGE_PRESETS[0];
  const shape = st.shape || preset.shape;
  const lines = (st.lines && st.lines.length) ? st.lines : preset.lines;
  const bg = st.bg || preset.bg;
  const fg = st.fg || preset.fg;
  const r = size / 2;
  ctx.save();
  if (shape === 'burst') {
    ctx.beginPath();
    const spikes = 12, outerR = r, innerR = r * 0.8;
    for (let i = 0; i < spikes * 2; i++) { const rr = i % 2 === 0 ? outerR : innerR; const a = (Math.PI / spikes) * i; const x = Math.sin(a) * rr, y = -Math.cos(a) * rr; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = bg; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.fill();
  } else if (shape === 'ribbon') {
    roundRect(ctx, -r, -r * 0.42, r * 2, r * 0.84, 8);
    ctx.fillStyle = bg; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = bg; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.fill();
  }
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lineH = r * (shape === 'ribbon' ? 0.62 : 0.52);
  const fontPx = Math.round(r * (lines.length > 1 ? 0.42 : 0.5));
  ctx.font = `900 ${fontPx}px 'Anton', sans-serif`;
  const totalH = (lines.length - 1) * lineH;
  lines.forEach((line, i) => ctx.fillText(line, 0, -totalH / 2 + i * lineH));
  ctx.restore();
}
// Basic shape elements — unlike stickers/badges these have independent width & height
// (not a single uniform scale), and are drawn in their own pass behind both photos and
// text (see drawPoster), so they work as background decoration.
const SHAPE_PRESETS = [
  { id: 'square', label: '⬛ Square' }, { id: 'rounded-square', label: '▢ Rounded' }, { id: 'circle', label: '⚫ Circle' },
  { id: 'triangle', label: '▲ Triangle' }, { id: 'triangle-down', label: '▼ Triangle' }, { id: 'diamond', label: '◆ Diamond' },
  { id: 'cross', label: '➕ Cross' }, { id: 'hexagon', label: '⬡ Hexagon' }, { id: 'pentagon', label: '⬠ Pentagon' },
  { id: 'parallelogram', label: '▱ Parallelogram' }, { id: 'trapezoid', label: '⏢ Trapezoid' }, { id: 'arch', label: '⌓ Arch' },
  { id: 'shield', label: '🛡️ Shield' }, { id: 'house', label: '🏠 House' }, { id: 'heart', label: '❤️ Heart' },
  { id: 'teardrop', label: '💧 Drop' }, { id: 'moon', label: '🌙 Moon' }, { id: 'leaf', label: '🍃 Leaf' },
  { id: 'play', label: '▶️ Play' }, { id: 'fast-forward', label: '⏩ Fast-fwd' }, { id: 'dots', label: '⚬ Dots' },
  { id: 'wave', label: '〰️ Wave' }, { id: 'frame', label: '⛶ Frame' }, { id: 'arrow-right', label: '➡️ Arrow' },
  { id: 'arrow-left', label: '⬅️ Arrow' }, { id: 'chevron-right', label: '❯ Chevron' }, { id: 'tag', label: '🏷️ Tag' },
  { id: 'flag', label: '🚩 Flag' }, { id: 'star', label: '⭐ Star' }, { id: 'burst', label: '💥 Burst' },
  { id: 'sparkle', label: '✦ Sparkle' }, { id: 'seal', label: '🎖️ Seal' }, { id: 'blob', label: '🫧 Blob' },
  { id: 'cloud', label: '☁️ Cloud' }, { id: 'clover', label: '🍀 Clover' }, { id: 'flower', label: '🌸 Flower' },
  { id: 'ring', label: '⭕ Ring' }, { id: 'pie', label: '🥧 Pie' }, { id: 'banner', label: '🎗️ Banner' }
];
const SHAPE_COLOR_CHOICES = [
  '#152420', '#1B342D', '#FFFFFF', '#F3ECDA', '#111827', '#1E293B',
  '#DC2626', '#EF4444', '#F87171', '#EA580C', '#F97316', '#FB923C',
  '#F59E0B', '#FBBF24', '#EAB308', '#CC9A3C', '#84CC16', '#65A30D',
  '#059669', '#10B981', '#0E6E5D', '#14B8A6', '#0EA5E9', '#0284C7',
  '#2563EB', '#1D4ED8', '#1E3A8A', '#4F46E5', '#7C3AED', '#8C3AA8',
  '#A855F7', '#C084FC', '#DB2777', '#EC4899', '#F472B6', '#78350F'
];
// Draws a star/burst/sparkle/seal-style outline with `points` spikes, alternating between
// full radius and innerRatio*radius, stretched independently on x (hw) and y (hh) so it
// still fits non-square boxes.
function starPath(ctx, hw, hh, points, innerRatio, rotOffset) {
  rotOffset = rotOffset || -Math.PI / 2;
  for (let i = 0; i < points * 2; i++) {
    const ratio = (i % 2 === 0) ? 1 : innerRatio;
    const a = rotOffset + (Math.PI / points) * i;
    const x = Math.cos(a) * hw * ratio, y = Math.sin(a) * hh * ratio;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function shapePath(ctx, kind, w, h) {
  const hw = w / 2, hh = h / 2;
  ctx.beginPath();
  if (kind === 'square') { ctx.rect(-hw, -hh, w, h); }
  else if (kind === 'rounded-square') { roundRect(ctx, -hw, -hh, w, h, Math.min(w, h) * 0.18); }
  else if (kind === 'circle') { ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2); }
  else if (kind === 'triangle') { ctx.moveTo(0, -hh); ctx.lineTo(hw, hh); ctx.lineTo(-hw, hh); ctx.closePath(); }
  else if (kind === 'triangle-down') { ctx.moveTo(-hw, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(0, hh); ctx.closePath(); }
  else if (kind === 'diamond') { ctx.moveTo(0, -hh); ctx.lineTo(hw, 0); ctx.lineTo(0, hh); ctx.lineTo(-hw, 0); ctx.closePath(); }
  else if (kind === 'cross') {
    const t = Math.min(w, h) * 0.34, ht = t / 2;
    ctx.rect(-ht, -hh, t, h); ctx.rect(-hw, -ht, w, t);
  } else if (kind === 'hexagon') {
    for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 2; const x = Math.cos(a) * hw, y = Math.sin(a) * hh; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.closePath();
  } else if (kind === 'pentagon') {
    for (let i = 0; i < 5; i++) { const a = (2 * Math.PI / 5) * i - Math.PI / 2; const x = Math.cos(a) * hw, y = Math.sin(a) * hh; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.closePath();
  } else if (kind === 'parallelogram') {
    const skew = w * 0.22;
    ctx.moveTo(-hw + skew, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(hw - skew, hh); ctx.lineTo(-hw, hh); ctx.closePath();
  } else if (kind === 'trapezoid') {
    const inset = w * 0.2;
    ctx.moveTo(-hw + inset, -hh); ctx.lineTo(hw - inset, -hh); ctx.lineTo(hw, hh); ctx.lineTo(-hw, hh); ctx.closePath();
  } else if (kind === 'arch') {
    ctx.moveTo(-hw, hh); ctx.lineTo(-hw, 0); ctx.arc(0, 0, hw, Math.PI, 0, false); ctx.lineTo(hw, hh); ctx.closePath();
  } else if (kind === 'shield') {
    ctx.moveTo(-hw, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(hw, hh * 0.2);
    ctx.quadraticCurveTo(hw, hh * 0.8, 0, hh); ctx.quadraticCurveTo(-hw, hh * 0.8, -hw, hh * 0.2); ctx.closePath();
  } else if (kind === 'house') {
    const roofH = h * 0.45;
    ctx.moveTo(0, -hh); ctx.lineTo(hw, -hh + roofH); ctx.lineTo(hw, hh); ctx.lineTo(-hw, hh); ctx.lineTo(-hw, -hh + roofH); ctx.closePath();
  } else if (kind === 'heart') {
    const topCurveHeight = h * 0.3, x = 0, y = -hh;
    ctx.moveTo(x, y + topCurveHeight);
    ctx.bezierCurveTo(x, y, x - w / 2, y, x - w / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x - w / 2, y + (h + topCurveHeight) / 2, x, y + (h + topCurveHeight) / 2, x, y + h);
    ctx.bezierCurveTo(x, y + (h + topCurveHeight) / 2, x + w / 2, y + (h + topCurveHeight) / 2, x + w / 2, y + topCurveHeight);
    ctx.bezierCurveTo(x + w / 2, y, x, y, x, y + topCurveHeight);
    ctx.closePath();
  } else if (kind === 'teardrop') {
    ctx.moveTo(0, -hh);
    ctx.bezierCurveTo(hw * 0.9, -hh * 0.1, hw, hh * 0.55, 0, hh);
    ctx.bezierCurveTo(-hw, hh * 0.55, -hw * 0.9, -hh * 0.1, 0, -hh);
    ctx.closePath();
  } else if (kind === 'moon') {
    const r = Math.min(hw, hh);
    ctx.arc(0, 0, r, Math.PI / 2, Math.PI * 1.5, false);
    ctx.arc(r * 0.6, 0, r * 0.95, Math.PI * 1.5, Math.PI / 2, true);
    ctx.closePath();
  } else if (kind === 'leaf') {
    ctx.moveTo(-hw, hh);
    ctx.quadraticCurveTo(-hw, -hh, hw, -hh);
    ctx.quadraticCurveTo(hw, hh, -hw, hh);
    ctx.closePath();
  } else if (kind === 'play') {
    ctx.moveTo(-hw * 0.6, -hh); ctx.lineTo(hw, 0); ctx.lineTo(-hw * 0.6, hh); ctx.closePath();
  } else if (kind === 'fast-forward') {
    ctx.moveTo(-hw, -hh); ctx.lineTo(0, 0); ctx.lineTo(-hw, hh); ctx.closePath();
    ctx.moveTo(0, -hh); ctx.lineTo(hw, 0); ctx.lineTo(0, hh); ctx.closePath();
  } else if (kind === 'dots') {
    const pos = [[-0.6, -0.6], [-0.1, -0.75], [0.45, -0.5], [0.7, -0.05], [0.5, 0.5], [0.05, 0.7], [-0.45, 0.55], [-0.75, 0.1], [0.05, 0.05], [-0.25, -0.1]];
    const dr = Math.min(hw, hh) * 0.15;
    pos.forEach(([px, py]) => { ctx.moveTo(px * hw + dr, py * hh); ctx.arc(px * hw, py * hh, dr, 0, Math.PI * 2); });
  } else if (kind === 'wave') {
    const amp = hh * 0.6, waveH = hh * 0.35;
    ctx.moveTo(-hw, -waveH);
    ctx.bezierCurveTo(-hw * 0.5, -waveH - amp, 0, -waveH + amp, hw, -waveH);
    ctx.lineTo(hw, waveH);
    ctx.bezierCurveTo(hw * 0.5, waveH + amp, 0, waveH - amp, -hw, waveH);
    ctx.closePath();
  } else if (kind === 'frame') {
    const t = Math.min(w, h) * 0.12, len = Math.min(w, h) * 0.34;
    ctx.rect(-hw, -hh, len, t); ctx.rect(-hw, -hh, t, len);
    ctx.rect(hw - len, -hh, len, t); ctx.rect(hw - t, -hh, t, len);
    ctx.rect(-hw, hh - t, len, t); ctx.rect(-hw, hh - len, t, len);
    ctx.rect(hw - len, hh - t, len, t); ctx.rect(hw - t, hh - len, t, len);
  } else if (kind === 'arrow-right') {
    const shaftH = h * 0.4, headW = w * 0.4;
    ctx.moveTo(-hw, -shaftH / 2); ctx.lineTo(hw - headW, -shaftH / 2); ctx.lineTo(hw - headW, -hh); ctx.lineTo(hw, 0);
    ctx.lineTo(hw - headW, hh); ctx.lineTo(hw - headW, shaftH / 2); ctx.lineTo(-hw, shaftH / 2); ctx.closePath();
  } else if (kind === 'arrow-left') {
    const shaftH = h * 0.4, headW = w * 0.4;
    ctx.moveTo(hw, -shaftH / 2); ctx.lineTo(-hw + headW, -shaftH / 2); ctx.lineTo(-hw + headW, -hh); ctx.lineTo(-hw, 0);
    ctx.lineTo(-hw + headW, hh); ctx.lineTo(-hw + headW, shaftH / 2); ctx.lineTo(hw, shaftH / 2); ctx.closePath();
  } else if (kind === 'chevron-right') {
    const t = w * 0.4;
    ctx.moveTo(-hw, -hh); ctx.lineTo(hw - t, -hh); ctx.lineTo(hw, 0); ctx.lineTo(hw - t, hh); ctx.lineTo(-hw, hh); ctx.lineTo(-hw + t, 0); ctx.closePath();
  } else if (kind === 'tag') {
    ctx.moveTo(-hw, -hh); ctx.lineTo(hw * 0.4, -hh); ctx.lineTo(hw, 0); ctx.lineTo(hw * 0.4, hh); ctx.lineTo(-hw, hh); ctx.closePath();
  } else if (kind === 'flag') {
    ctx.moveTo(-hw, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(hw, hh); ctx.lineTo(0, hh * 0.4); ctx.lineTo(-hw, hh); ctx.closePath();
  } else if (kind === 'star') {
    starPath(ctx, hw, hh, 5, 0.5);
  } else if (kind === 'burst') {
    starPath(ctx, hw, hh, 14, 0.7);
  } else if (kind === 'sparkle') {
    starPath(ctx, hw, hh, 4, 0.35);
  } else if (kind === 'seal') {
    starPath(ctx, hw, hh, 12, 0.88);
  } else if (kind === 'blob') {
    ctx.moveTo(-hw * 0.8, -hh * 0.15);
    ctx.bezierCurveTo(-hw * 0.9, -hh * 0.75, hw * 0.25, -hh * 0.9, hw * 0.75, -hh * 0.45);
    ctx.bezierCurveTo(hw * 0.95, -hh * 0.05, hw * 0.6, hh * 0.75, hw * 0.1, hh * 0.85);
    ctx.bezierCurveTo(-hw * 0.5, hh * 0.95, -hw * 0.9, hh * 0.3, -hw * 0.8, -hh * 0.15);
    ctx.closePath();
  } else if (kind === 'cloud') {
    const r = hh * 0.5;
    ctx.moveTo(-hw * 0.6, hh * 0.3);
    ctx.arc(-hw * 0.5, 0, r * 0.9, Math.PI * 0.5, Math.PI * 1.5, false);
    ctx.arc(-hw * 0.1, -hh * 0.35, r, Math.PI * 0.85, Math.PI * 1.85, false);
    ctx.arc(hw * 0.35, -hh * 0.15, r * 1.05, Math.PI * 1.3, Math.PI * 0.35, false);
    ctx.arc(hw * 0.55, hh * 0.15, r * 0.7, Math.PI * 1.5, Math.PI * 0.6, false);
    ctx.lineTo(-hw * 0.6, hh * 0.3);
    ctx.closePath();
  } else if (kind === 'clover') {
    const r = Math.min(hw, hh) * 0.5;
    [[0, -r], [r, 0], [0, r], [-r, 0]].forEach(([cx, cy]) => { ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); });
  } else if (kind === 'flower') {
    const n = 6, r = Math.min(hw, hh) * 0.42, dist = Math.min(hw, hh) * 0.42;
    for (let i = 0; i < n; i++) { const a = (Math.PI * 2 / n) * i; const cx = Math.cos(a) * dist, cy = Math.sin(a) * dist; ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); }
    ctx.moveTo(r * 0.6, 0); ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
  } else if (kind === 'ring') {
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.moveTo(hw * 0.55, 0); ctx.ellipse(0, 0, hw * 0.55, hh * 0.55, 0, 0, Math.PI * 2, true);
  } else if (kind === 'pie') {
    const r = Math.min(hw, hh);
    ctx.moveTo(0, 0); ctx.arc(0, 0, r, -Math.PI * 0.5, Math.PI * 0.35, false); ctx.closePath();
  } else if (kind === 'banner') {
    const notch = w * 0.08;
    ctx.moveTo(-hw, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(hw - notch, 0); ctx.lineTo(hw, hh); ctx.lineTo(-hw, hh); ctx.lineTo(-hw + notch, 0); ctx.closePath();
  } else { ctx.rect(-hw, -hh, w, h); }
}
function drawShapeElement(ctx, st, w, h) {
  shapePath(ctx, st.kind || 'square', w, h);
  ctx.fillStyle = st.color || '#152420';
  ctx.fill(st.kind === 'ring' ? 'evenodd' : 'nonzero');
}
// Draws one sticker/badge/shape element plus its selection outline (if selected). Called
// twice from drawPoster: once for shapes only (before photos), once for everything else
// (emoji/badge/image stickers, before text) — so z-order stays: shapes < photos < stickers
// < text.
async function drawStickerElement(ed, st, W, H) {
  const r = stickerRect(st), cx = st.x * W, cy = st.y * H;
  ctx.save(); ctx.translate(cx, cy); ctx.rotate((st.rotation || 0) * Math.PI / 180);
  if (st.isShape) {
    drawShapeElement(ctx, st, r.w, r.h);
  } else if (st.emoji) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(r.size * 0.82)}px sans-serif`;
    ctx.fillText(st.emoji, 0, 0);
  } else if (st.badge) {
    drawBadgeSticker(ctx, st, r.size);
  } else if (st.imageUrl) {
    const im = await loadImg(st.imageUrl);
    if (im) ctx.drawImage(im, -r.size / 2, -r.size / 2, r.size, r.size);
  }
  ctx.restore();
  if (ed._selectedSticker === st.id) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((st.rotation || 0) * Math.PI / 180);
    ctx.strokeStyle = 'rgba(204,154,60,0.9)'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
    roundRect(ctx, -r.w / 2 - 4, -r.h / 2 - 4, r.w + 8, r.h + 8, 10); ctx.stroke(); ctx.restore();
  }
}
function wrapLines(ctx, text, maxWidth) {
  const words = (text || '').split(' ').filter(Boolean); let line = '', lines = [];
  for (let n = 0; n < words.length; n++) { const test = line + words[n] + ' '; if (ctx.measureText(test).width > maxWidth && line !== '') { lines.push(line.trim()); line = words[n] + ' '; } else line = test; }
  if (line.trim()) lines.push(line.trim()); return lines.length ? lines : [''];
}
function wrapFillTextCenter(ctx, text, cx, y, maxWidth, lineHeight, maxLines) {
  const lines = wrapLines(ctx, text, maxWidth).slice(0, maxLines || 2);
  const totalH = (lines.length - 1) * lineHeight, startY = y - totalH / 2, prevAlign = ctx.textAlign;
  ctx.textAlign = 'center'; lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight)); ctx.textAlign = prevAlign;
}
function parseNum(str) { if (!str) return null; const n = parseFloat(String(str).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }

// A curve value of 0 = straight. |curve| up to 100 = tighter bend. Sign decides bend direction
// (up "smile" vs down "frown"). Radius is chosen so the bend stays gentle at low values and
// pronounced near 100, independent of how long the text is.
function curveRadiusForAmount(curve) {
  return Math.max(90, 2600 - Math.abs(curve) * 24);
}
// Extra vertical room (sagitta of the arc) a curved line of the given width needs, so the
// selection box and hit-testing still cover the bent glyphs.
function curveSagitta(curve, textWidth) {
  if (!curve) return 0;
  const radius = curveRadiusForAmount(curve);
  const halfW = Math.min(textWidth / 2, radius - 1);
  return radius - Math.sqrt(Math.max(0, radius * radius - halfW * halfW));
}
// Splits text into whole visual characters ("grapheme clusters") rather than raw Unicode
// code points. This matters a lot for Malayalam and other Indic scripts: a vowel sign like
// ു or ി is a separate code point that only renders correctly glued to its base consonant.
// Array.from() would split them apart and draw each piece alone at a different angle along
// the arc — which makes them disappear or render as broken marks. Intl.Segmenter keeps
// each base+matra/conjunct together as one unit so curved Malayalam text stays readable.
function graphemeSplit(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(text), s => s.segment);
    } catch (e) { /* fall through */ }
  }
  return Array.from(text);
}
// Draws `text` character-by-character along a circular arc centered directly below (curve>0)
// or above (curve<0) the current origin, so the whole string bends like a banner. `drawFn(ch)`
// does the actual per-character fill/stroke using whatever style is active.
function drawCurvedText(ctx, text, curve, drawFn) {
  const chars = graphemeSplit(text);
  if (!chars.length) return;
  const radius = curveRadiusForAmount(curve);
  const sign = curve >= 0 ? 1 : -1;
  const widths = chars.map(c => ctx.measureText(c).width);
  let angle = -sign * ((widths.reduce((a, b) => a + b, 0) / 2) / radius);
  const prevAlign = ctx.textAlign, prevBaseline = ctx.textBaseline;
  ctx.textAlign = 'center';
  ctx.textBaseline = sign > 0 ? 'bottom' : 'top';
  ctx.save();
  // Re-center: rotating/translating by `radius` (often 1500-2500px) would otherwise place
  // every character that far from the point the text was actually dragged to — off the
  // canvas entirely. Shifting the circle's center by `radius` first puts the arc's crest
  // (angle 0) back at the origin, so the bent text stays right where it was placed.
  ctx.translate(0, sign * radius);
  for (let i = 0; i < chars.length; i++) {
    const half = (widths[i] / 2) / radius;
    angle += sign * half;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(0, -sign * radius);
    drawFn(chars[i]);
    ctx.restore();
    angle += sign * half;
  }
  ctx.restore();
  ctx.textAlign = prevAlign; ctx.textBaseline = prevBaseline;
}

function textLayerBoundingBoxAt00(ctx, ed, tl, content, W, H, fontFamily, mlFont) {
  // Measures a text layer's box assuming it were drawn centered at (0,0), used both for
  // actual drawing (after ctx.translate/rotate) and for hit-testing (after inverse-rotating
  // the tap point into the text's local space).
  const scale = tl.scale || 1;
  const curve = tl.curve || 0;
  if (tl.key === 'headline') {
    const isMl = /[\u0D00-\u0D7F]/.test(content);
    const fam = resolveTextFontCss(ed, content, fontFamily);
    let fontPx = W * textLayerBaseSizeFrac('headline') * scale;
    ctx.font = `900 ${Math.round(fontPx)}px ${fam}`;
    if (curve) {
      // Curved headline is drawn as one continuous arc, not wrapped into lines.
      const full = content.trim();
      while (ctx.measureText(full).width > W * 0.95 && fontPx > 10) {
        fontPx -= 2; ctx.font = `900 ${Math.round(fontPx)}px ${fam}`;
      }
      const w = ctx.measureText(full).width + fontPx * 0.5;
      const h = fontPx * 1.6 + curveSagitta(curve, w);
      return { fontPx, full, w, h, isMl, fam };
    }
    let lines = content.trim().split(/\s+/).slice(0, 4);
    while (lines.some(t => ctx.measureText(t).width > W * 0.72) && fontPx > 10) {
      fontPx -= 2;
      ctx.font = `900 ${Math.round(fontPx)}px ${fam}`;
    }
    const lh = fontPx * 0.78;
    const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + fontPx * 0.5;
    const h = lines.length * lh + fontPx * 0.5;
    return { fontPx, lines, lh, w, h, isMl, fam };
  }
  if (tl.key === 'pill') {
    const fontPx = W * textLayerBaseSizeFrac('pill') * scale;
    ctx.font = `700 ${Math.round(fontPx)}px ${fontFamily}`;
    const tw = ctx.measureText(content).width, pillW = tw + W * 0.07, pillH = fontPx * 2.1;
    return { fontPx, pillW, pillH, w: pillW, h: pillH };
  }
  const isMl = /[\u0D00-\u0D7F]/.test(content);
  const fam = resolveTextFontCss(ed, content, fontFamily);
  const fontPx = W * textLayerBaseSizeFrac(tl.key) * scale;
  const weight = tl.key === 'footerShop' ? 800 : (tl.key === 'headerShop' ? 700 : 500);
  ctx.font = `${weight} ${Math.round(fontPx)}px ${fam}`;
  const rawW = ctx.measureText(content).width;
  const w = rawW + fontPx * 0.7;
  const h = fontPx * 1.7 + curveSagitta(curve, rawW);
  return { fontPx, weight, isMl, fam, w, h };
}

function drawTextLayer(ctx, ed, tl, content, W, H, fontFamily, mlFont) {
  const cx = tl.x * W, cy = tl.y * H;
  const rot = ((tl.rotation || 0) * Math.PI) / 180;
  const curve = tl.curve || 0;
  const m = textLayerBoundingBoxAt00(ctx, ed, tl, content, W, H, fontFamily, mlFont);
  tl._measured = { w: m.w, h: m.h };

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (tl.key === 'headline') {
    ctx.font = `900 ${Math.round(m.fontPx)}px ${m.fam}`;
    if (curve) {
      // Curved headline keeps the bold outline but uses a flat fill instead of the vertical
      // gradient (a per-character gradient would look inconsistent along a bend). If the
      // user picked a Text Color, use it; otherwise fall back to the default gold look.
      const flatColor = ed.textColor || '#FFC000';
      drawCurvedText(ctx, m.full, curve, (ch) => {
        for (let d = 8; d >= 1; d--) { ctx.fillStyle = '#8B2500'; ctx.fillText(ch, d * 0.6, d * 0.6); }
        ctx.lineWidth = 6; ctx.strokeStyle = '#6B1D00'; ctx.strokeText(ch, 0, 0);
        ctx.fillStyle = flatColor; ctx.fillText(ch, 0, 0);
      });
    } else {
      const totalH = (m.lines.length - 1) * m.lh;
      m.lines.forEach((text, i) => {
        const y = -totalH / 2 + i * m.lh;
        for (let d = 10; d >= 1; d--) { ctx.fillStyle = '#8B2500'; ctx.fillText(text, d, y + d); }
        ctx.lineWidth = 7; ctx.strokeStyle = '#6B1D00'; ctx.strokeText(text, 0, y);
        if (ed.textColor) {
          // A Text Color was explicitly picked — use it as a flat fill instead of the
          // default rainbow-gold gradient, so the color swatch actually has an effect.
          ctx.fillStyle = ed.textColor;
        } else {
          const g = ctx.createLinearGradient(0, y - m.fontPx / 2, 0, y + m.fontPx / 2);
          g.addColorStop(0, '#FFF7A0'); g.addColorStop(.20, '#FFE04A'); g.addColorStop(.45, '#FFC000'); g.addColorStop(.75, '#FF8C00'); g.addColorStop(1, '#F4511E');
          ctx.fillStyle = g;
        }
        ctx.fillText(text, 0, y);
      });
    }
  } else if (tl.key === 'pill') {
    ctx.font = `700 ${Math.round(m.fontPx)}px ${fontFamily}`;
    roundRect(ctx, -m.pillW / 2, -m.pillH / 2, m.pillW, m.pillH, m.pillH / 2);
    ctx.fillStyle = 'rgba(19,36,32,0.38)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
    roundRect(ctx, -m.pillW / 2, -m.pillH / 2, m.pillW, m.pillH, m.pillH / 2); ctx.stroke();
    ctx.fillStyle = ed.pillTextColor || '#fff';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    ctx.fillText(content, 0, 1); ctx.restore();
  } else {
    ctx.font = `${m.weight} ${Math.round(m.fontPx)}px ${m.fam}`;
    // headerShop used to be hardcoded white regardless of the Text Color swatch — now it
    // honors ed.textColor too, falling back to a soft white if nothing was picked.
    const fallback = tl.key === 'headerShop' ? 'rgba(255,255,255,0.92)' : '#FFFFFF';
    const fillColor = ed.textColor || fallback;
    if (curve) {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
      drawCurvedText(ctx, content, curve, (ch) => { ctx.fillStyle = fillColor; ctx.fillText(ch, 0, 0); });
      ctx.restore();
    } else {
      ctx.fillStyle = fillColor;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
      ctx.fillText(content, 0, 1); ctx.restore();
    }
  }

  if (ed._selectedText === tl.id) {
    ctx.strokeStyle = 'rgba(204,154,60,0.9)'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
    roundRect(ctx, -m.w / 2, -m.h / 2, m.w, m.h, 8); ctx.stroke();
  }
  ctx.restore();
}

let renderQueued = false;
function renderPoster() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(async () => { renderQueued = false; await drawPoster(); }); }

async function drawPoster() {
  const ed = STATE.editor; if (!ed) return;
  ensureTexts(ed);
  const W = canvas.width, H = canvas.height;
  const theme = ed.theme;
  const isGradientTheme = ed.themeType === 'gradient' && ed.themeGradient;
  const gradA = isGradientTheme ? ed.themeGradient[0] : shadeColor(theme, -30);
  const gradB = isGradientTheme ? ed.themeGradient[1] : theme;
  const fontFamily = FONT_OPTIONS.find(f => f.id === ed.font)?.css || FONT_OPTIONS[0].css;
  const mlFont = FONT_OPTIONS.find(f => f.id === 'ml').css;
  ctx.clearRect(0, 0, W, H);

  const borderless = !!ed.borderless;
  const headerH = borderless ? 0 : H * HEADER_FRAC;
  const footerH = borderless ? 0 : H * FOOTER_FRAC;
  const gridY = headerH; 
  const gridH = H - headerH - footerH;
  const borderWidth = borderless ? 0 : W * 0.025; 
  const usableW = W - (borderWidth * 2);
  const outerPad = usableW * 0.02;
// 1. ഹെഡർ ബാനർ അല്ലെങ്കിൽ ഗ്രേഡിയന്റ് ബാക്ക്ഗ്രൗണ്ട് വരയ്ക്കുന്നു (borderless മോഡിൽ ഇത് വേണ്ട)
  if (borderless) {
    // Full-bleed single-screen background — one flat color/gradient covers the whole
    // canvas, no separate header/footer bands or side border strips.
    if (isGradientTheme) {
      const full = ctx.createLinearGradient(0, 0, W, H);
      full.addColorStop(0, gradA); full.addColorStop(1, gradB);
      ctx.fillStyle = full;
    } else {
      ctx.fillStyle = theme;
    }
    ctx.fillRect(0, 0, W, H);
  } else if (ed.heroBanner) {
    const him = await loadImg(ed.heroBanner);
    if (him && him.complete) {
      ctx.save(); 
      roundRect(ctx, 0, 0, W, headerH, 0); 
      ctx.clip();
      const scale = Math.max(W / him.width, headerH / him.height);
      const iw = him.width * scale, ih = him.height * scale;
      ctx.drawImage(him, (W - iw) / 2, (headerH - ih) / 2, iw, ih); 
      ctx.restore();
    } else {
      drawHeaderGradient();
    }
  } else {
    drawHeaderGradient();
  }
  function drawHeaderGradient() {
    const hgrad = ctx.createLinearGradient(0, 0, W, headerH); hgrad.addColorStop(0, gradA); hgrad.addColorStop(1, gradB);
    ctx.fillStyle = hgrad; ctx.fillRect(0, 0, W, headerH);
    ctx.save(); ctx.globalAlpha = 0.10; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(W * 0.92, headerH * 0.15, W * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(W * 0.05, headerH * 0.9, W * 0.10, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }

  if (ed.logo) {
    const im = await loadImg(ed.logo);
    if (im) {
      const baseSize = (borderless ? H * 0.30 : headerH) * 0.42;
      const wScale = ed.logoWidthScale !== undefined ? ed.logoWidthScale : (ed.logoScale || 1);
      const hScale = ed.logoHeightScale !== undefined ? ed.logoHeightScale : (ed.logoScale || 1);
      const lw = baseSize * wScale, lh = baseSize * hScale;
      const lx = (ed.logoX !== undefined ? ed.logoX : 0.05) * W;
      const ly = (ed.logoY !== undefined ? ed.logoY : 0.04) * H;
      ctx.save(); roundRect(ctx, lx, ly, lw, lh, 10); ctx.fillStyle = '#fff'; ctx.fill(); ctx.clip();
      ctx.drawImage(im, lx, ly, lw, lh); ctx.restore();
    }
  }

  if (!borderless) {
    ctx.fillStyle = '#F2F6F8'; 
    ctx.fillRect(borderWidth, gridY, usableW, gridH);
  }

  // Shape elements draw here, BEFORE the photo boxes and text — so they always sit behind
  // both, working as background decoration rather than covering the photo or text.
  if (ed.stickers && ed.stickers.length) {
    for (const st of ed.stickers) {
      if (st.isShape) await drawStickerElement(ed, st, W, H);
    }
  }

  for (let i = 0; i < ed.slots.length; i++) {
    const s = ed.slots[i];
    const cx = borderWidth + outerPad + s.x * (usableW - outerPad * 2), cy = gridY + outerPad + s.y * (gridH - outerPad * 2);
    const cw = s.w * (usableW - outerPad * 2), ch = s.h * (gridH - outerPad * 2);
    let pad, imgX, imgY, imgW, imgH;
    if (borderless) {
      // No white card behind the photo — it sits directly on the banner's own background
      // and fills nearly the whole box, no space reserved below for a caption.
      pad = cw * 0.012;
      imgX = cx + pad; imgY = cy + pad; imgW = cw - pad * 2; imgH = ch - pad * 2;
    } else {
      ctx.save(); roundRect(ctx, cx, cy, cw, ch, 12); ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(19,36,32,0.14)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3; ctx.fill(); ctx.restore();
      pad = cw * 0.045; imgH = ch * 0.62; imgX = cx + pad; imgY = cy + pad * 0.8; imgW = cw - pad * 2;
    }
    ctx.save(); roundRect(ctx, imgX, imgY, imgW, imgH, borderless ? 16 : 8); ctx.clip();
    if (s.img) {
      const im = await loadImg(s.img);
      if (im) {
        const hRatio = imgW / im.width, vRatio = imgH / im.height;
        const ratio = Math.min(hRatio, vRatio) * (s.zoom || 1);
        const iw = im.width * ratio, ih = im.height * ratio;
        const ix = imgX + (imgW - iw) / 2 + (s.offX - 0.5) * imgW;
        const iy = imgY + (imgH - ih) / 2 + (s.offY - 0.5) * imgH;
        ctx.drawImage(im, ix, iy, iw, ih);
      }
    } else {
      ctx.fillStyle = '#EDF1F0'; ctx.fillRect(imgX, imgY, imgW, imgH); ctx.fillStyle = '#B7C4C0';
      ctx.font = `${Math.round(imgW * 0.22)}px Manrope`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('📷', imgX + imgW / 2, imgY + imgH / 2);
    }
    ctx.restore();

    const mrpNum = parseNum(s.mrp), offNum = parseNum(s.offerPrice);
    const priceScale = s.priceScale || 1;
    const priceStyle = s.priceStyle || 'rect';
    const priceTagX = imgX + cw * 0.01 + (s.priceOffX || 0) * cw;
    const priceTagY = imgY + ch * 0.02 + (s.priceOffY || 0) * ch;
    if (s.mrp) {
      const tw2 = Math.max(cw * 0.30, imgW * 0.34) * priceScale, th = ch * 0.11 * priceScale, tx = priceTagX, ty = priceTagY;
      drawPriceBox(ctx, priceStyle, tx, ty, tw2, th, s.mrpColor || '#FFD23C');
      ctx.fillStyle = '#1c1204'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(th * 0.42)}px Manrope`; ctx.fillText('MRP', tx + tw2 / 2, ty + th * 0.32);
      ctx.font = `800 ${Math.round(th * 0.5)}px Manrope`; ctx.fillText('₹' + s.mrp, tx + tw2 / 2, ty + th * 0.78);
      if (s.offerPrice) {
        const t2y = ty + th + ch * 0.012; drawPriceBox(ctx, priceStyle, tx, t2y, tw2, th, s.offerColor || '#E1273B');
        ctx.fillStyle = '#fff'; ctx.font = `900 ${Math.round(th * 0.6)}px Manrope`; ctx.fillText('₹' + s.offerPrice, tx + tw2 / 2, t2y + th * 0.58);
      }
    } else if (s.offerPrice) {
      const tw2 = Math.max(cw * 0.30, imgW * 0.34) * priceScale, th = ch * 0.11 * priceScale, tx = priceTagX, ty = priceTagY;
      drawPriceBox(ctx, priceStyle, tx, ty, tw2, th, s.offerColor || '#E1273B');
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(th * 0.55)}px Manrope`; ctx.fillText('₹' + s.offerPrice, tx + tw2 / 2, ty + th * 0.58);
    }
    if (mrpNum && offNum && mrpNum > offNum) {
      const pct = Math.round((mrpNum - offNum) / mrpNum * 100), r = Math.min(cw, ch) * 0.115;
      const ccx = imgX + imgW - r * 0.95 + (s.pctOffX || 0) * cw, ccy = imgY + r * 0.95 + (s.pctOffY || 0) * ch;
      ctx.beginPath(); ctx.arc(ccx, ccy, r, 0, Math.PI * 2); ctx.fillStyle = '#8C3AA8'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(r * 0.5)}px Manrope`; ctx.fillText(pct + '%', ccx, ccy - r * 0.14);
      ctx.font = `700 ${Math.round(r * 0.32)}px Manrope`; ctx.fillText('OFF', ccx, ccy + r * 0.32);
    }
    if (s.offerText) {
      if (borderless) {
        // No reserved caption space below the photo here — show it as a semi-transparent
        // bar overlaid on the bottom edge of the photo itself instead.
        const capH = ch * 0.13;
        ctx.save();
        roundRect(ctx, imgX, imgY + imgH - capH, imgW, capH, 0);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
        ctx.fillStyle = s.productNameColor || ed.productTextColor || '#FFFFFF';
        ctx.font = `700 ${Math.round(cw * 0.055)}px ${fontFamily}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        wrapFillTextCenter(ctx, s.offerText, imgX + imgW / 2, imgY + imgH - capH / 2, imgW - cw * 0.06, cw * 0.06, 1);
        ctx.restore();
      } else {
        // Own per-slot color if set, else the global Style tab → PRODUCT NAME TEXT COLOR,
        // else dark (which reads well on the light product card).
        ctx.fillStyle = s.productNameColor || ed.productTextColor || '#152420';
        ctx.font = `700 ${Math.round(cw * 0.062)}px ${fontFamily}`; 
        ctx.textAlign = 'center'; 
        ctx.textBaseline = 'middle';
        wrapFillTextCenter(ctx, s.offerText, cx + cw / 2, imgY + imgH + (ch - imgH - pad * 0.8) / 2, cw - pad * 1.6, cw * 0.07, 2);
      }
    }
  }

  if (!borderless) {
    const footY = H - footerH;
    ctx.fillStyle = isGradientTheme ? shadeColor(gradB, -35) : shadeColor(theme, -35);
    ctx.fillRect(0, footY, W, footerH);

    // Draw Side Borders over everything so they are clearly visible
    const sideGrad = ctx.createLinearGradient(0, 0, W, 0);
    sideGrad.addColorStop(0, gradA);
    sideGrad.addColorStop(1, gradB);
    ctx.fillStyle = sideGrad;
    ctx.fillRect(0, headerH, borderWidth, gridH);               
    ctx.fillRect(W - borderWidth, headerH, borderWidth, gridH);   
  }

  if (STATE.profile.plan === 'free') {
    ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = '#132420';
    ctx.font = `800 ${Math.round(W * 0.06)}px ${fontFamily}`; ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 8); ctx.textAlign = 'center';
    ctx.fillText(STATE.settings.watermark_text || 'OFFER POSTER STUDIO', 0, 0); ctx.restore();
  }

  // Stickers/badges are drawn here — BEFORE the text layer pass below — so text always stays
  // on top and readable. Shape elements are NOT drawn here — they're drawn earlier, behind
  // the photo boxes (see the pass right after the header background above).
  if (ed.stickers && ed.stickers.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const st of ed.stickers) {
      if (st.isShape) continue;
      await drawStickerElement(ed, st, W, H);
    }
  }

  // Draggable text layers — always drawn last, on top of stickers and every other layer.
  if (ed.texts) {
    for (const tl of ed.texts) {
      if (tl.visible === false) continue;
      const content = textLayerContent(ed, tl.key);
      if (!content) continue;
      drawTextLayer(ctx, ed, tl, content, W, H, fontFamily, mlFont);
    }
  }
}
 
let dragState = null;
function canvasPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX, clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  return { x: (clientX - rect.left) / rect.width * canvas.width, y: (clientY - rect.top) / rect.height * canvas.height };
}
function slotImageRect(s) {
  const W = canvas.width, H = canvas.height, ed = STATE.editor;
  const borderless = !!(ed && ed.borderless);
  const headerH = borderless ? 0 : H * HEADER_FRAC, footerH = borderless ? 0 : H * FOOTER_FRAC, gridY = headerH, gridH = H - headerH - footerH;
  const borderWidth = borderless ? 0 : W * 0.025, usableW = W - (borderWidth * 2), outerPad = usableW * 0.02;
  const cx = borderWidth + outerPad + s.x * (usableW - outerPad * 2), cy = gridY + outerPad + s.y * (gridH - outerPad * 2), cw = s.w * (usableW - outerPad * 2), ch = s.h * (gridH - outerPad * 2);
  if (borderless) {
    const pad = cw * 0.012;
    return { x: cx + pad, y: cy + pad, w: cw - pad * 2, h: ch - pad * 2 };
  }
  const pad = cw * 0.045, imgH = ch * 0.62;
  return { x: cx + pad, y: cy + pad * 0.8, w: cw - pad * 2, h: imgH };
}
function findSlotAt(px, py) { const ed = STATE.editor; if (!ed) return -1; for (let i = 0; i < ed.slots.length; i++) { const r = slotImageRect(ed.slots[i]); if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i; } return -1; }
function stickerRect(st) {
  const W = canvas.width, H = canvas.height;
  if (st.isShape) {
    const w = (st.w || 0.25) * W, h = (st.h || 0.18) * H;
    return { x: (st.x * W) - w / 2, y: (st.y * H) - h / 2, w, h, size: Math.max(w, h) };
  }
  const size = Math.min(W, H) * 0.11 * (st.scale || 1);
  return { x: (st.x * W) - size / 2, y: (st.y * H) - size / 2, w: size, h: size, size };
}
function findStickerAt(px, py) { const ed = STATE.editor; if (!ed?.stickers) return -1; for (let i = ed.stickers.length - 1; i >= 0; i--) { const r = stickerRect(ed.stickers[i]); if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i; } return -1; }
function findTextAt(px, py) {
  const ed = STATE.editor; if (!ed?.texts) return -1;
  const W = canvas.width, H = canvas.height;
  for (let i = ed.texts.length - 1; i >= 0; i--) {
    const tl = ed.texts[i];
    if (tl.visible === false) continue;
    const content = textLayerContent(ed, tl.key);
    if (!content) continue;
    const m = tl._measured; if (!m) continue;
    const cx = tl.x * W, cy = tl.y * H;
    const rot = -((tl.rotation || 0) * Math.PI) / 180;
    const dx = px - cx, dy = py - cy;
    const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ly = dx * Math.sin(rot) + dy * Math.cos(rot);
    if (Math.abs(lx) <= m.w / 2 && Math.abs(ly) <= m.h / 2) return i;
  }
  return -1;
}

function onCanvasDown(evt) {
  const p = canvasPos(evt);
  const txtIdx = findTextAt(p.x, p.y);
  if (txtIdx >= 0) {
    const tl = STATE.editor.texts[txtIdx];
    const wasSelected = STATE.editor._selectedText === tl.id;
    deselectSticker();
    dragState = { text: true, idx: txtIdx, startX: p.x, startY: p.y, startPosX: tl.x, startPosY: tl.y, moved: false, historyPushed: false, preSnapshot: snapshotEditor(), wasSelected };
    return;
  }
  const stIdx = findStickerAt(p.x, p.y);
  if (stIdx >= 0) {
    deselectText();
    dragState = { sticker: true, idx: stIdx, startX: p.x, startY: p.y, startPosX: STATE.editor.stickers[stIdx].x, startPosY: STATE.editor.stickers[stIdx].y, moved: false, historyPushed: false, preSnapshot: snapshotEditor() };
    return;
  }
  const idx = findSlotAt(p.x, p.y);
  if (idx >= 0) {
    deselectSticker(); deselectText();
    dragState = { idx, startX: p.x, startY: p.y, offX: STATE.editor.slots[idx].offX, offY: STATE.editor.slots[idx].offY, moved: false, historyPushed: false, preSnapshot: snapshotEditor() };
    return;
  }
  deselectSticker(); deselectText();
}
function onCanvasMove(evt) {
  if (!dragState) return; evt.preventDefault();
  const p = canvasPos(evt), totalDx = p.x - dragState.startX, totalDy = p.y - dragState.startY;
  if (Math.abs(totalDx) > 4 || Math.abs(totalDy) > 4) {
    dragState.moved = true;
    if (!dragState.historyPushed) { historyStack.push(dragState.preSnapshot); if (historyStack.length > 30) historyStack.shift(); redoStack = []; updateUndoRedoButtons(); dragState.historyPushed = true; }
  }
  if (dragState.text) {
    const W = canvas.width, H = canvas.height;
    STATE.editor.texts[dragState.idx].x = Math.min(1, Math.max(0, dragState.startPosX + totalDx / W));
    STATE.editor.texts[dragState.idx].y = Math.min(1, Math.max(0, dragState.startPosY + totalDy / H));
    renderPoster(); return;
  }
  if (dragState.sticker) {
    const W = canvas.width, H = canvas.height;
    STATE.editor.stickers[dragState.idx].x = Math.min(1, Math.max(0, dragState.startPosX + totalDx / W));
    STATE.editor.stickers[dragState.idx].y = Math.min(1, Math.max(0, dragState.startPosY + totalDy / H));
    renderPoster(); return;
  }
  const s = STATE.editor.slots[dragState.idx];
  if (!s.img) return;
  const r = slotImageRect(s);
  s.offX = Math.min(1, Math.max(0, dragState.offX - totalDx / r.w));
  s.offY = Math.min(1, Math.max(0, dragState.offY - totalDy / r.h));
  renderPoster();
}
function onCanvasUp() {
  if (dragState?.text && !dragState.moved) {
    if (dragState.wasSelected) { openTextInlineEdit(STATE.editor.texts[dragState.idx]); }
    else { selectTextByIdx(dragState.idx); }
    dragState = null; return;
  }
  if (dragState?.sticker && !dragState.moved) { selectStickerByIdx(dragState.idx); dragState = null; return; }
  if (dragState && !dragState.sticker && !dragState.text && !dragState.moved) { openSlotEditor(dragState.idx); }
  dragState = null;
}
canvas.addEventListener('mousedown', onCanvasDown); canvas.addEventListener('mousemove', onCanvasMove); window.addEventListener('mouseup', onCanvasUp);
canvas.addEventListener('touchstart', onCanvasDown, { passive: true }); canvas.addEventListener('touchmove', onCanvasMove, { passive: false }); canvas.addEventListener('touchend', onCanvasUp);

let zoomLevel = 1;
function resetZoom() { zoomLevel = 1; document.getElementById('canvasFrame').style.transform = 'scale(1)'; document.getElementById('zoomLabel').textContent = '100%'; }
function setZoom(delta) { zoomLevel = Math.min(1.6, Math.max(0.5, zoomLevel + delta)); document.getElementById('canvasFrame').style.transform = `scale(${zoomLevel})`; document.getElementById('zoomLabel').textContent = Math.round(zoomLevel * 100) + '%'; }

let inlineEditHistoryPushed = false;
function openInlineEdit(title, fields) {
  inlineEditHistoryPushed = false;
  document.getElementById('inlineEditTitle').textContent = title;
  document.getElementById('inlineEditFields').innerHTML = fields.map(f => `
    <div class="field"><label>${escapeHtml(f.label)}</label>
      <input type="text" value="${escapeHtml(STATE.editor[f.key] || '')}" oninput="onFieldInput('${f.key}', this.value)"></div>`).join('');
  openSheet('sheetInlineEdit');
  setTimeout(() => { const el = document.querySelector('#inlineEditFields input'); if (el) el.focus(); }, 250);
}

function updatePlanBanner() {
  const banner = document.getElementById('limitBanner');
  if (STATE.profile.plan !== 'free') { banner.style.display = 'none'; return; }
  sb.from('downloads_log').select('id', { count: 'exact', head: true }).eq('user_id', STATE.user.id).gte('created_at', todayStr() + 'T00:00:00').then(({ count }) => {
    const limit = STATE.settings.free_download_limit ?? 1;
    document.getElementById('downloadsLeft').textContent = Math.max(0, limit - (count || 0));
    banner.style.display = 'flex';
  });
}
const SIZE_PRESETS = [
  { id: 'shelftag_land', label: 'Shelf Tag Card (16:9)', w: 1080, h: 1350 },
  { id: 'poster', label: 'Standard Poster (4:5)', w: 1080, h: 1350 }, 
  { id: 'ig', label: 'Instagram Square (1:1)', w: 1080, h: 1350 }, 
  { id: 'wa', label: 'WhatsApp Status (9:16)', w: 1080, h: 1350}, 
  { id: 'fb', label: 'Facebook Landscape (1200x630)', w: 1080, h: 1350 }
];
let exportSize = SIZE_PRESETS[0], exportFormat = 'png', exportHD = false;
function openExportSheet() {
  document.getElementById('sizeChips').innerHTML = SIZE_PRESETS.map(p => `<div class="pill ${exportSize.id === p.id ? 'active' : ''}" onclick="setExportSize('${p.id}')">${p.label}</div>`).join('');
  document.getElementById('formatChips').innerHTML = ['png', 'jpg'].map(f => `<div class="pill ${exportFormat === f ? 'active' : ''}" onclick="setExportFormat('${f}')">${f.toUpperCase()}</div>`).join('');
  document.getElementById('qualityChips').innerHTML = `<div class="pill ${!exportHD ? 'active' : ''}" onclick="setExportQuality(false)">Standard</div><div class="pill ${exportHD ? 'active' : ''}" onclick="setExportQuality(true)">✨ HD (2x)</div>`;
  const warn = document.getElementById('inAppBrowserWarning');
  if (warn) {
    if (isInAppBrowser()) {
      warn.style.display = 'block';
      warn.innerHTML = '⚠️ Facebook/Instagram പോലുള്ള ആപ്പിനുള്ളിലെ ബ്രൗസറിൽ ആണ് ഇത് തുറന്നിരിക്കുന്നത് — Download ചിലപ്പോൾ പ്രവർത്തിക്കില്ല. പ്രശ്നമുണ്ടെങ്കിൽ മുകളിലെ ⋮ മെനുവിൽ നിന്ന് "Open in Chrome/Browser" തിരഞ്ഞെടുക്കുക.';
    } else {
      warn.style.display = 'none';
    }
  }
  openSheet('sheetExport');
}
function setExportSize(id) { exportSize = SIZE_PRESETS.find(p => p.id === id); openExportSheet(); }
function setExportFormat(f) { exportFormat = f; openExportSheet(); }
function setExportQuality(hd) { exportHD = hd; openExportSheet(); }

async function doExport() {
  const ed = STATE.editor;
  if (STATE.profile.plan === 'free') {
    const { count } = await sb.from('downloads_log').select('id', { count: 'exact', head: true }).eq('user_id', STATE.user.id).gte('created_at', todayStr() + 'T00:00:00');
    const limit = STATE.settings.free_download_limit ?? 1;
    if ((count || 0) >= limit) { toast('Daily free limit reached. Upgrade for unlimited downloads.', true); closeSheets(); goto('payment'); return; }
  } else if (await planQuotaExceeded('image')) { toast('Your plan\'s download limit is used up. Choose a plan to continue.', true); closeSheets(); goto('payment'); return; }
  const mult = exportHD ? 2 : 1;
  const exportCanvas = document.createElement('canvas'); exportCanvas.width = exportSize.w * mult; exportCanvas.height = exportSize.h * mult;
  const ectx = exportCanvas.getContext('2d');
  const origW = canvas.width, origH = canvas.height;
  canvas.width = exportSize.w * mult; canvas.height = exportSize.h * mult;
  await drawPoster();

  // The rounded corners you see in the editor are only a CSS effect on the preview frame —
  // the canvas pixels themselves were always a plain rectangle, so downloads came out square-
  // cornered. Baking the same rounding into the exported image here fixes that.
  const cornerRadius = Math.round(Math.min(exportCanvas.width, exportCanvas.height) * 0.035);
  if (exportFormat === 'jpg') {
    // JPG has no transparency, so the corners need a real fill behind them instead of being
    // left see-through (which would otherwise render as solid black in most photo viewers).
    ectx.fillStyle = '#FBF6EA';
    ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  }
  ectx.save();
  roundRect(ectx, 0, 0, exportCanvas.width, exportCanvas.height, cornerRadius);
  ectx.clip();
  ectx.drawImage(canvas, 0, 0);
  ectx.restore();

  canvas.width = origW; canvas.height = origH; renderPoster();

  const mime = exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
  const dataUrl = exportCanvas.toDataURL(mime, 0.92);
  const filename = `${(ed.title || 'poster').replace(/\s+/g, '_')}_${exportSize.id}${exportHD ? '_HD' : ''}.${exportFormat}`;

  // Facebook/Instagram/etc. open links in a restricted in-app browser where the normal
  // <a download> trick often silently fails (it may just open the image instead of saving
  // it). In that case, try the device's native Share sheet instead — "Save Image"/"Save to
  // Photos" from there works even when a direct download doesn't.
  let savedViaShare = false;
  if (isInAppBrowser() && navigator.share) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: ed.title || 'Poster' });
        savedViaShare = true;
      }
    } catch (e) {
      // Share sheet cancelled or unsupported — fall through to the normal download attempt.
    }
  }

  if (!savedViaShare) {
    const a = document.createElement('a'); a.href = dataUrl; a.download = filename; a.click();
    if (isInAppBrowser() && !navigator.share) {
      toast('Facebook/Instagram-ന്റെ ഉള്ളിലെ ബ്രൗസറിൽ Download പ്രവർത്തിച്ചില്ലെങ്കിൽ, മുകളിലെ ⋮ മെനുവിൽ നിന്ന് "Open in Chrome" / "Open in Browser" തിരഞ്ഞെടുത്ത് വീണ്ടും ശ്രമിക്കുക.', true);
    }
  }

  await sb.from('downloads_log').insert({ user_id: STATE.user.id, template_id: ed.templateId, format: exportFormat, size_preset: exportSize.id, hd: exportHD });
  if (ed.templateId) { const t = STATE.templates.find(t => t.id === ed.templateId); if (t) { t.downloads = (t.downloads || 0) + 1; await sb.from('templates').update({ downloads: t.downloads }).eq('id', ed.templateId); } }
  await savePosterRecord('final');
  updatePlanBanner(); toast(savedViaShare ? 'Poster ready — saved via Share sheet!' : 'Poster downloaded!'); closeSheets();
}
// Facebook, Instagram, Messenger, WhatsApp, WeChat, Twitter/X, Snapchat, LINE, LinkedIn all
// ship their own restrictive in-app browser (WebView) when you open a link from inside them —
// these commonly block or silently no-op the <a download> trick that works fine in Chrome/Safari.
function isInAppBrowser() {
  const ua = navigator.userAgent || navigator.vendor || '';
  return /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|LinkedInApp|Snapchat/i.test(ua);
}
async function savePosterRecord(type) {
  const ed = STATE.editor;
  const thumb = canvas.toDataURL('image/jpeg', 0.6);
  const payload = { user_id: STATE.user.id, template_id: ed.templateId, title: ed.title, state: ed, thumb_url: thumb, type, updated_at: new Date().toISOString() };
  if (ed.dbId) {
    await sb.from('posters').update(payload).eq('id', ed.dbId);
  } else {
    const { data, error } = await sb.from('posters').insert(payload).select().single();
    if (!error && data) ed.dbId = data.id;
  }
}
function saveDraft() { savePosterRecord('draft'); toast('Draft saved to My Studio'); closeSheets(); }
async function resumePoster(posterId) {
  const { data, error } = await sb.from('posters').select('*').eq('id', posterId).single();
  if (error || !data) { toast('Could not load that poster', true); return; }
  STATE.editor = data.state; STATE.editor.dbId = data.id;
  ensureTexts(STATE.editor);
  enterEditor();
}

let currentLibCat = 'all';
function renderLibraryGallery() {
  const cats = [{ id: 'all', label: 'All Categories' }, ...STATE.categories];
  const catPills = document.getElementById('libCategoryPills');
  if (catPills) {
    catPills.innerHTML = cats.map(c => 
      `<div class="pill ${currentLibCat === c.id ? 'active' : ''}" onclick="setLibCat('${c.id}')">${escapeHtml(c.label)}</div>`
    ).join('');
  }

  let list = STATE.products || [];
  const q = (document.getElementById('libSearchInput')?.value || '').toLowerCase().trim();
  if (currentLibCat !== 'all') { list = list.filter(p => p.category_id === currentLibCat); }
  if (q) { list = list.filter(p => (p.name || '').toLowerCase().includes(q)); }

  const libGrid = document.getElementById('libGrid');
  if (libGrid) {
    libGrid.innerHTML = list.length ? list.map(p => `
      <div class="poster-item">
        <div class="pv" style="background-image:url('${p.image_url}')"></div>
        <div style="padding:10px;">
          <div style="font-weight:700;font-size:12.5px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.name)}</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px;">MRP: ₹${p.mrp || '-'} | Offer: ₹${p.offer_price || '-'}</div>
          <button class="btn btn-primary btn-block btn-sm" onclick="downloadProductImage('${p.image_url}', '${escapeHtml(p.name)}')">📥 Download Photo</button>
        </div>
      </div>
    `).join('') : `<div class="empty-state" style="grid-column:1/-1;"><div class="ic">📦</div><h3>No photos found</h3><p>Try changing the category or search.</p></div>`;
  }
}
function setLibCat(catId) {
  currentLibCat = catId;
  renderLibraryGallery();
}
async function downloadProductImage(url, name) {
  try {
    toast('Downloading photo...');
    const cleanName = (name || 'product').replace(/[^a-zA-Z0-9]/g, '_');
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${cleanName}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);
    toast('Photo downloaded successfully!');
  } catch (err) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.download = 'product.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('Download started!');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await boot();
  // Deep-link support: opening this file at #signup / #login jumps straight to that auth
  // tab; opening at #templates / #features / #pricing / #contact / #privacy / #terms opens
  // that page directly — so links and bookmarks to a "page" behave like real page links.
  const hash = (location.hash || '').replace('#', '');
  if (!STATE.user) {
    if (hash === 'signup') { showAuth(); setAuthMode('signup'); }
    else if (hash === 'login') { showAuth(); setAuthMode('login'); }
    else if (PUBLIC_SCREENS.includes(hash)) { showPublicScreen(hash); }
  } else if (PUBLIC_SCREENS.includes(hash)) {
    showPublicScreen(hash);
  }
});

/* ############ DESIGN STUDIO (new) — everything below this line is additive ############ */

/* script.js declares STATE / sb / FONT_OPTIONS with let/const, which are NOT window properties.
   The Studio modules read them through window.*, so expose live getters for them. */
try { if (!Object.getOwnPropertyDescriptor(window, 'STATE')) Object.defineProperty(window, 'STATE', { get() { return STATE; }, configurable: true }); } catch (e) { /* ignore */ }
try { if (!Object.getOwnPropertyDescriptor(window, 'sb')) Object.defineProperty(window, 'sb', { get() { return sb; }, configurable: true }); } catch (e) { /* ignore */ }
try { if (!Object.getOwnPropertyDescriptor(window, 'FONT_OPTIONS')) Object.defineProperty(window, 'FONT_OPTIONS', { get() { return FONT_OPTIONS; }, configurable: true }); } catch (e) { /* ignore */ }

// ======================= studio.js =======================
// ===================================================================================
// DESIGN STUDIO — core (canvas, layers, history, pages, zoom, grid, export)
//
// Independent from script.js / STATE.editor (the original poster maker). Reuses only a few
// generic globals from script.js: toast(), escapeHtml(), goto(), STATE, sb, FONT_OPTIONS.
// Feature modules (loaded after this file) plug in through Studio.api / Studio.registerTab:
//   studio-lib.js   shapes, stickers, frames, text styles, curved text, backgrounds
//   studio-fx.js    properties panel: text effects, photo editing, filters, crop, frames
//   studio-tpl.js   template library (categories, search, favourites, previews)
//   studio-tools.js logo maker, business card, social studio, brochure / invitation maker
//   studio-store.js My Designs (IndexedDB), uploads, history, plan gating, admin dashboard
//   video.js        separate video / slideshow module
// ===================================================================================

const STUDIO_TABLE_SQL = `
-- Optional cloud sync tables for Design Studio (see studio-store.js). Run once in Supabase.
create table if not exists studio_designs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text default 'Untitled Design',
  doc jsonb,
  thumb text,
  width int, height int,
  updated_at timestamptz default now()
);
alter table studio_designs enable row level security;
create policy "own studio designs" on studio_designs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
`;

var Studio = (() => {
  // Custom properties that must survive JSON save/load/undo.
  const INCLUDE = ['selectable', 'evented', 'lockMovementX', 'lockMovementY', 'lockRotation', 'lockScalingX', 'lockScalingY',
    'hasControls', 'studioLocked', 'studioName', 'studioFx', 'studioCurve', 'studioFrame', 'studioKind'];

  let canvas = null, booted = false;
  let designW = 1080, designH = 1080, designMM = null; // designMM = {w,h} physical size in mm (print presets)
  let zoomLevel = 1, userZoomed = false;
  let gridOn = false; const gridSize = 20;
  let history = [], historyIndex = -1, applyingHistory = false;
  let designName = 'Untitled Design', docId = null, docKind = 'design';
  let pages = [null], pageIndex = 0;
  let panelTab = 'design', drawerTab = null;
  let changeTimer = null, arrowNudgeTimer = null;
  const tabs = []; // drawer tabs registered by modules

  // ------------------------------------------------------------------ boot
  function enterScreen() {
    if (!booted) { boot(); booted = true; }
    fitZoom(); canvas.calcOffset(); canvas.requestRenderAll();
    if (window.StudioStore) StudioStore.onEnterStudio();
  }
  function onExit() { flushSave(); }

  function boot() {
    canvas = new fabric.Canvas('studioCanvas', {
      width: designW, height: designH, backgroundColor: '#ffffff', preserveObjectStacking: true,
      selectionColor: 'rgba(204,154,60,0.18)', selectionBorderColor: '#CC9A3C', stopContextMenu: true, fireRightClick: false
    });
    // Larger, touch-friendly handles (Phase 1 requirement: touch dragging/resizing on phones).
    fabric.Object.prototype.set({ cornerSize: 14, touchCornerSize: 28, transparentCorners: false, cornerColor: '#0E6E5D', cornerStrokeColor: '#fff', borderColor: '#0E6E5D', padding: 2 });

    canvas.on('object:modified', () => { commit(); });
    canvas.on('object:added', () => { if (!applyingHistory) renderLayers(); });
    canvas.on('object:removed', () => { if (!applyingHistory) renderLayers(); });
    canvas.on('selection:created', onSelectionChanged);
    canvas.on('selection:updated', onSelectionChanged);
    canvas.on('selection:cleared', () => { renderProps(null); renderLayers(); });
    canvas.on('object:moving', snapObjectToGrid);
    canvas.on('object:scaling', () => { if (window.StudioFx) StudioFx.onScaling(canvas.getActiveObject()); });
    canvas.on('text:editing:exited', () => commit());

    document.getElementById('studioCanvasScroll').addEventListener('scroll', renderRulers);
    window.addEventListener('resize', () => { if (!userZoomed) fitZoom(); else renderRulers(); });
    setupKeyboardShortcuts();
    if (window.StudioLib) StudioLib.initBackgrounds();
    pushHistory(true); renderLayers(); updateZoomLabel(); renderPagebar();
    renderDrawerTabs();
  }

  function onSelectionChanged() {
    if (panelTab !== 'layers') studioSetPanelTab('props');
    renderProps(canvas.getActiveObject());
    renderLayers();
  }

  // ------------------------------------------------------------------ helpers
  function api() { return Studio.api; }
  function center() { return { left: designW / 2, top: designH / 2 }; }
  function snapshot() { return JSON.stringify(canvas.toJSON(INCLUDE)); }
  function blankPageJSON(bg) { return JSON.stringify({ version: fabric.version, objects: [], background: bg || '#ffffff' }); }
  function addObj(o, opts) {
    o.set(Object.assign({ originX: 'center', originY: 'center' }, (opts && opts.keepPos) ? {} : center()));
    canvas.add(o); canvas.setActiveObject(o); canvas.requestRenderAll(); commit();
    return o;
  }
  function refreshText() {
    try { fabric.util.clearFabricFontCache(); } catch (e) { /* older build */ }
    canvas.getObjects().forEach(function re(o) { if (o.initDimensions) o.initDimensions(); if (o._objects) o._objects.forEach(re); o.dirty = true; });
    canvas.requestRenderAll();
  }
  // Waits until Google Fonts used by the given CSS font-family strings are really loaded, so text
  // measures/draws with the intended font instead of a fallback (matters for Indian scripts).
  async function ensureFonts(list, sample) {
    if (!document.fonts || !document.fonts.load) return;
    const jobs = (list || []).map(f => document.fonts.load(`700 40px ${f}`, sample || 'Aa മലയാളം हिंदी தமிழ்').catch(() => { }));
    try { await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ history
  function commit() { pushHistory(); renderLayers(); renderProps(canvas.getActiveObject(), true); }
  function pushHistory(isInitial) {
    if (applyingHistory) return;
    const snap = snapshot();
    if (!isInitial && history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1); history.push(snap);
    if (history.length > 60) history.shift();
    historyIndex = history.length - 1;
    updateUndoRedoButtons(); scheduleSave();
  }
  function resetHistory() { history = []; historyIndex = -1; pushHistory(true); }
  function undo() { if (historyIndex > 0) { historyIndex--; applyHistoryState(); } }
  function redo() { if (historyIndex < history.length - 1) { historyIndex++; applyHistoryState(); } }
  function applyHistoryState() {
    applyingHistory = true;
    canvas.loadFromJSON(history[historyIndex], () => {
      canvas.renderAll(); applyingHistory = false;
      renderLayers(); renderProps(canvas.getActiveObject()); updateUndoRedoButtons(); scheduleSave();
    });
  }
  function updateUndoRedoButtons() {
    const u = document.getElementById('studioUndoBtn'), r = document.getElementById('studioRedoBtn');
    if (u) u.disabled = historyIndex <= 0; if (r) r.disabled = historyIndex >= history.length - 1;
  }

  // ------------------------------------------------------------------ document (pages / save)
  function getDoc() {
    pages[pageIndex] = snapshot();
    return { id: docId, kind: docKind, name: designName, width: designW, height: designH, mm: designMM, pageIndex, pages: pages.slice() };
  }
  function scheduleSave() { clearTimeout(changeTimer); changeTimer = setTimeout(flushSave, 1200); }
  function flushSave() { clearTimeout(changeTimer); if (canvas && window.StudioStore) StudioStore.autosave(getDoc()); }

  // Loads one page JSON (string) into the live canvas.
  function loadPageJSON(json, cb) {
    applyingHistory = true;
    canvas.loadFromJSON(json, () => {
      applyingHistory = false;
      applyZoomRaw(zoomLevel); refreshText(); canvas.renderAll();
      resetHistory(); renderLayers(); renderProps(null); renderPagebar(); if (cb) cb();
    });
  }
  // Replace the whole document (used by templates, tools, My Designs).
  // doc = {name,width,height,mm,pages:[jsonString...],pageIndex,kind,id}
  function loadDoc(doc, opts) {
    designW = doc.width; designH = doc.height; designMM = doc.mm || null; designName = doc.name || 'Untitled Design';
    docId = doc.id || null; docKind = doc.kind || 'design';
    pages = doc.pages.slice(); pageIndex = Math.min(doc.pageIndex || 0, pages.length - 1);
    document.getElementById('studioDesignName').value = designName;
    syncSizeInputs(); userZoomed = false;
    canvas.setDimensions({ width: designW, height: designH });
    loadPageJSON(pages[pageIndex] || blankPageJSON(), () => { fitZoom(); if (!(opts && opts.noSave)) scheduleSave(); });
  }
  // A "spec" is what template builders return: {bg: fillSpec|string, objs:[fabric objects]}.
  function specToJSON(spec, W, H) {
    const sc = new fabric.StaticCanvas(null, { width: W, height: H });
    sc.backgroundColor = (StudioLib && StudioLib.makeFill) ? StudioLib.makeFill(spec.bg, W, H) : (spec.bg || '#fff');
    (spec.objs || []).forEach(o => sc.add(o));
    const json = JSON.stringify(sc.toJSON(INCLUDE));
    sc.dispose && sc.dispose();
    return json;
  }
  // doc built from builders: {name,width,height,mm,kind,pages:[spec...]}
  function loadBuilt(built) {
    const W = built.width, H = built.height;
    loadDoc({ name: built.name, width: W, height: H, mm: built.mm, kind: built.kind, id: null, pages: built.pages.map(p => specToJSON(p, W, H)) });
  }
  function newDoc(name, w, h, mm, kind) {
    loadDoc({ name: name || 'Untitled Design', width: w, height: h, mm: mm || null, kind: kind || 'design', pages: [blankPageJSON()] });
  }
  function setName(v) { designName = v || 'Untitled Design'; scheduleSave(); }

  function storeCurrentPage() { pages[pageIndex] = snapshot(); }
  function switchPage(i) {
    if (i === pageIndex || i < 0 || i >= pages.length) return;
    storeCurrentPage(); pageIndex = i; loadPageJSON(pages[i], scheduleSave);
  }
  function addPage(duplicate) {
    storeCurrentPage();
    pages.splice(pageIndex + 1, 0, duplicate ? pages[pageIndex] : blankPageJSON());
    pageIndex++; loadPageJSON(pages[pageIndex], scheduleSave);
  }
  function deletePage() {
    if (pages.length < 2) { toast('A design needs at least one page', true); return; }
    pages.splice(pageIndex, 1); pageIndex = Math.max(0, pageIndex - 1);
    loadPageJSON(pages[pageIndex], scheduleSave);
  }
  function movePage(dir) {
    const j = pageIndex + dir; if (j < 0 || j >= pages.length) return;
    storeCurrentPage(); [pages[pageIndex], pages[j]] = [pages[j], pages[pageIndex]]; pageIndex = j; renderPagebar(); scheduleSave();
  }
  function renderPagebar() {
    const el = document.getElementById('studioPagebar'); if (!el) return;
    el.innerHTML = pages.map((_, i) => `<button class="studio-page-chip ${i === pageIndex ? 'active' : ''}" onclick="Studio.switchPage(${i})">${i + 1}</button>`).join('') +
      `<button class="studio-page-chip" title="Add blank page" onclick="Studio.addPage(false)">＋</button>
       <button class="studio-page-chip" title="Duplicate this page" onclick="Studio.addPage(true)">⧉</button>
       <button class="studio-page-chip" title="Move page left" onclick="Studio.movePage(-1)">◀</button>
       <button class="studio-page-chip" title="Move page right" onclick="Studio.movePage(1)">▶</button>
       <button class="studio-page-chip danger" title="Delete this page" onclick="Studio.deletePage()">🗑</button>`;
  }

  // ------------------------------------------------------------------ basic add
  function addRect() { return addObj(new fabric.Rect({ width: 220, height: 150, fill: '#0E6E5D', studioKind: 'rect' })); }
  function addEllipse() { return addObj(new fabric.Ellipse({ rx: 110, ry: 80, fill: '#CC9A3C', studioKind: 'ellipse' })); }
  function addTriangle() { return addObj(new fabric.Triangle({ width: 180, height: 160, fill: '#E1553B', studioKind: 'triangle' })); }
  function addLine() {
    return addObj(new fabric.Line([-120, 0, 120, 0], { stroke: '#152420', strokeWidth: 6, studioKind: 'line' }));
  }
  function addText(opts) {
    opts = opts || {};
    const o = new fabric.IText(opts.text || 'Double-tap to edit', Object.assign({ fontFamily: "'Manrope',sans-serif", fontSize: 64, fill: '#152420', textAlign: 'center', studioKind: 'text' }, opts));
    return addObj(o);
  }
  function handleImageUpload(e) {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    files.forEach(f => addImageFile(f)); e.target.value = '';
  }
  function addImageFile(file) {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) { toast('Use PNG, JPG or WebP images', true); return; }
    if (file.size > 15 * 1024 * 1024) { toast('Image is larger than 15 MB', true); return; }
    const reader = new FileReader();
    reader.onload = ev => { addImageURL(ev.target.result); if (window.StudioStore) StudioStore.addUpload(file.name, ev.target.result); };
    reader.readAsDataURL(file);
  }
  function addImageURL(url, opts) {
    opts = opts || {};
    fabric.Image.fromURL(url, img => {
      if (!img || !img.width) { toast('Could not load that image', true); return; }
      const maxDim = Math.min(designW, designH) * (opts.fill || 0.7);
      const s = Math.min(1, maxDim / Math.max(img.width, img.height));
      img.set({ scaleX: s, scaleY: s, studioKind: 'image', studioFx: { origW: img.width, origH: img.height } });
      addObj(img);
    }, { crossOrigin: 'anonymous' });
  }

  // ------------------------------------------------------------------ selection actions
  function activeObjs() { return canvas.getActiveObjects(); }
  function deleteSelection() {
    const a = activeObjs(); if (!a.length) return;
    a.forEach(o => canvas.remove(o)); canvas.discardActiveObject(); canvas.requestRenderAll(); commit();
  }
  function duplicateSelection() {
    const active = canvas.getActiveObject(); if (!active) return;
    active.clone(cloned => {
      canvas.discardActiveObject();
      cloned.set({ left: (active.left || 0) + 24, top: (active.top || 0) + 24, evented: true });
      if (cloned.type === 'activeSelection') { cloned.canvas = canvas; cloned.forEachObject(o => canvas.add(o)); cloned.setCoords(); }
      else canvas.add(cloned);
      canvas.setActiveObject(cloned); canvas.requestRenderAll(); commit();
    }, INCLUDE);
  }
  let clipboard = null;
  function copySelection() { const a = canvas.getActiveObject(); if (!a) return; a.clone(c => { clipboard = c; toast('Copied'); }, INCLUDE); }
  function pasteSelection() {
    if (!clipboard) return;
    clipboard.clone(cloned => {
      canvas.discardActiveObject();
      cloned.set({ left: (cloned.left || 0) + 24, top: (cloned.top || 0) + 24, evented: true });
      if (cloned.type === 'activeSelection') { cloned.canvas = canvas; cloned.forEachObject(o => canvas.add(o)); cloned.setCoords(); }
      else canvas.add(cloned);
      clipboard.set({ left: cloned.left, top: cloned.top });
      canvas.setActiveObject(cloned); canvas.requestRenderAll(); commit();
    }, INCLUDE);
  }
  function selectAll() {
    const objs = canvas.getObjects().filter(o => o.selectable !== false && o.visible !== false);
    if (!objs.length) return;
    canvas.discardActiveObject();
    canvas.setActiveObject(objs.length === 1 ? objs[0] : new fabric.ActiveSelection(objs, { canvas }));
    canvas.requestRenderAll();
  }
  function groupSelection() {
    const a = canvas.getActiveObject();
    if (!a || a.type !== 'activeSelection') { toast('Select two or more objects to group them', true); return; }
    a.toGroup(); canvas.requestRenderAll(); commit();
  }
  function ungroupSelection() {
    const a = canvas.getActiveObject();
    if (!a || a.type !== 'group') { toast('Select a group to ungroup it', true); return; }
    if (a.studioCurve) { toast('Curved text is one object — edit it in the Edit tab', true); return; }
    a.toActiveSelection(); canvas.requestRenderAll(); commit();
  }
  function toggleLockSelection() {
    const a = canvas.getActiveObject(); if (!a) return;
    const lock = !a.studioLocked;
    const apply = o => o.set({ studioLocked: lock, lockMovementX: lock, lockMovementY: lock, lockRotation: lock, lockScalingX: lock, lockScalingY: lock, hasControls: !lock });
    if (a.type === 'activeSelection') a.forEachObject(apply); else apply(a);
    canvas.requestRenderAll(); commit();
  }
  function flip(axis) {
    const a = canvas.getActiveObject(); if (!a) return;
    a.set(axis === 'x' ? 'flipX' : 'flipY', !(axis === 'x' ? a.flipX : a.flipY)); canvas.requestRenderAll(); commit();
  }
  function bringToFront() { const a = canvas.getActiveObject(); if (a) { canvas.bringToFront(a); commit(); } }
  function sendToBack() { const a = canvas.getActiveObject(); if (a) { canvas.sendToBack(a); commit(); } }
  function bringForwardSel() { const a = canvas.getActiveObject(); if (a) { canvas.bringForward(a); commit(); } }
  function sendBackwardSel() { const a = canvas.getActiveObject(); if (a) { canvas.sendBackwards(a); commit(); } }

  // Align relative to the page (single object/selection) or to each other (multi-select + 'rel' mode).
  function align(mode) {
    const a = canvas.getActiveObject(); if (!a) return;
    a.setCoords(); const b = a.getBoundingRect(true, true);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = -b.left; else if (mode === 'right') dx = designW - (b.left + b.width);
    else if (mode === 'centerH') dx = (designW - b.width) / 2 - b.left;
    else if (mode === 'top') dy = -b.top; else if (mode === 'bottom') dy = designH - (b.top + b.height);
    else if (mode === 'centerV') dy = (designH - b.height) / 2 - b.top;
    a.set({ left: a.left + dx, top: a.top + dy }); a.setCoords(); canvas.requestRenderAll(); commit();
  }
  // Align / distribute members of a multi-selection relative to each other.
  function alignEach(mode) {
    const a = canvas.getActiveObject(); if (!a || a.type !== 'activeSelection') { toast('Select two or more objects first', true); return; }
    const objs = a.getObjects().slice();
    canvas.discardActiveObject();
    const rects = objs.map(o => { o.setCoords(); return { o, b: o.getBoundingRect(true, true) }; });
    const minL = Math.min(...rects.map(r => r.b.left)), maxR = Math.max(...rects.map(r => r.b.left + r.b.width));
    const minT = Math.min(...rects.map(r => r.b.top)), maxB = Math.max(...rects.map(r => r.b.top + r.b.height));
    if (mode === 'distH' || mode === 'distV') {
      const horiz = mode === 'distH';
      rects.sort((p, q) => horiz ? p.b.left - q.b.left : p.b.top - q.b.top);
      const total = rects.reduce((s, r) => s + (horiz ? r.b.width : r.b.height), 0);
      const span = horiz ? (maxR - minL) : (maxB - minT);
      const gap = rects.length > 1 ? (span - total) / (rects.length - 1) : 0;
      let pos = horiz ? minL : minT;
      rects.forEach(r => {
        if (horiz) { r.o.set('left', r.o.left + (pos - r.b.left)); pos += r.b.width + gap; }
        else { r.o.set('top', r.o.top + (pos - r.b.top)); pos += r.b.height + gap; }
        r.o.setCoords();
      });
    } else {
      rects.forEach(r => {
        let dx = 0, dy = 0;
        if (mode === 'left') dx = minL - r.b.left; else if (mode === 'right') dx = maxR - (r.b.left + r.b.width);
        else if (mode === 'centerH') dx = (minL + maxR) / 2 - (r.b.left + r.b.width / 2);
        else if (mode === 'top') dy = minT - r.b.top; else if (mode === 'bottom') dy = maxB - (r.b.top + r.b.height);
        else if (mode === 'centerV') dy = (minT + maxB) / 2 - (r.b.top + r.b.height / 2);
        r.o.set({ left: r.o.left + dx, top: r.o.top + dy }); r.o.setCoords();
      });
    }
    canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas })); canvas.requestRenderAll(); commit();
  }
  function setPosition(key, val) {
    const a = canvas.getActiveObject(); if (!a || isNaN(val)) return;
    a.setCoords();
    if (key === 'x' || key === 'y') { const b = a.getBoundingRect(true, true); a.set(key === 'x' ? { left: a.left + (val - b.left) } : { top: a.top + (val - b.top) }); }
    else if (key === 'w') a.scaleToWidth(Math.max(4, val)); else if (key === 'h') a.scaleToHeight(Math.max(4, val));
    a.setCoords(); canvas.requestRenderAll(); commit();
  }

  // ------------------------------------------------------------------ grid / snapping
  function toggleGrid() {
    gridOn = !gridOn; document.getElementById('studioGridBtn').classList.toggle('active', gridOn); drawGridOverlay();
  }
  function snapObjectToGrid(opt) {
    if (!gridOn || !opt.target) return;
    const o = opt.target; o.set({ left: Math.round(o.left / gridSize) * gridSize, top: Math.round(o.top / gridSize) * gridSize });
  }
  function drawGridOverlay() {
    const el = document.getElementById('studioGridOverlay'); if (!el) return;
    const w = Math.round(designW * zoomLevel), h = Math.round(designH * zoomLevel);
    el.width = w; el.height = h; el.style.width = w + 'px'; el.style.height = h + 'px';
    el.style.display = gridOn ? 'block' : 'none'; if (!gridOn) return;
    const ctx = el.getContext('2d'); ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(19,36,32,0.16)'; ctx.lineWidth = 1;
    let step = gridSize * zoomLevel; while (step < 8) step *= 2;
    for (let x = 0; x <= w; x += step) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += step) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke(); }
  }

  // ------------------------------------------------------------------ zoom
  function applyZoomRaw(z) {
    zoomLevel = Math.max(0.05, Math.min(4, Math.round(z * 1000) / 1000));
    canvas.setZoom(zoomLevel);
    canvas.setDimensions({ width: Math.round(designW * zoomLevel), height: Math.round(designH * zoomLevel) });
    updateZoomLabel(); drawGridOverlay(); renderRulers();
  }
  function applyZoom(z, manual) { if (manual) userZoomed = true; applyZoomRaw(z); }
  function fitZoom() {
    userZoomed = false;
    const sc = document.getElementById('studioCanvasScroll'); if (!sc || !sc.clientWidth) return;
    const availW = sc.clientWidth - 48, availH = sc.clientHeight - 48;
    applyZoomRaw(Math.max(0.05, Math.min(availW / designW, availH / designH, 1.5)));
  }
  const zoomIn = () => applyZoom(zoomLevel * 1.2, true), zoomOut = () => applyZoom(zoomLevel / 1.2, true);
  const zoomReset = () => applyZoom(1, true);
  function updateZoomLabel() { const l = document.getElementById('studioZoomLabel'); if (l) l.textContent = Math.round(zoomLevel * 100) + '%'; }

  // ------------------------------------------------------------------ rulers (scroll + zoom synced)
  function renderRulers() {
    const h = document.getElementById('studioRulerH'), v = document.getElementById('studioRulerV'), stack = document.getElementById('studioCanvasStack');
    const wrap = document.getElementById('studioCanvasWrap');
    if (!h || !v || !stack || !wrap || !canvas) return;
    const sr = stack.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const offX = sr.left - wr.left - 18, offY = sr.top - wr.top - 18; // canvas origin relative to ruler origin
    const steps = [10, 25, 50, 100, 200, 250, 500, 1000, 2000]; const step = steps.find(s => s * zoomLevel >= 48) || 2000;
    let hh = '', vv = '';
    for (let x = 0; x <= designW; x += step) { const px = offX + x * zoomLevel; if (px > -40 && px < h.clientWidth + 40) hh += `<span class="rt" style="left:${px}px">${x}</span>`; }
    for (let y = 0; y <= designH; y += step) { const py = offY + y * zoomLevel; if (py > -40 && py < v.clientHeight + 40) vv += `<span class="rt rv" style="top:${py}px">${y}</span>`; }
    h.innerHTML = hh; v.innerHTML = vv;
  }

  // ------------------------------------------------------------------ canvas size
  function syncSizeInputs() {
    const w = document.getElementById('studioCanvasW'), h = document.getElementById('studioCanvasH');
    if (w) w.value = designW; if (h) h.value = designH;
  }
  function setSize(w, h, mm, scaleContent) {
    const nw = Math.max(50, Math.min(6000, Math.round(w))), nh = Math.max(50, Math.min(6000, Math.round(h)));
    if (scaleContent && (nw !== designW || nh !== designH)) {
      // Resize page and scale the content proportionally (so presets like "Instagram Story" re-flow a design).
      const s = Math.min(nw / designW, nh / designH), dx = (nw - designW * s) / 2, dy = (nh - designH * s) / 2;
      canvas.getObjects().forEach(o => { o.set({ left: o.left * s + dx, top: o.top * s + dy, scaleX: o.scaleX * s, scaleY: o.scaleY * s }); o.setCoords(); });
    }
    designW = nw; designH = nh; designMM = mm || null; syncSizeInputs();
    fitZoom(); canvas.requestRenderAll(); commit();
  }
  function setCanvasSizeFromInputs() {
    const w = parseInt(document.getElementById('studioCanvasW').value) || designW, h = parseInt(document.getElementById('studioCanvasH').value) || designH;
    setSize(w, h, null, false);
  }

  // ------------------------------------------------------------------ layers panel
  function layerName(o) {
    if (o.studioName) return o.studioName;
    const t = o.type;
    if (t === 'i-text' || t === 'text' || t === 'textbox') return 'T  ' + (o.text || '').replace(/\n/g, ' ').slice(0, 18);
    if (o.studioCurve) return '⌒ Curved text';
    if (t === 'image') return '🖼️ Image';
    if (t === 'group') return '⛓️ Group';
    return ({ rect: '▭ Rectangle', ellipse: '⬭ Ellipse', circle: '⬤ Circle', triangle: '△ Triangle', line: '╱ Line', path: '✦ Shape', polygon: '⬠ Shape' }[t]) || t;
  }
  function renderLayers() {
    const list = document.getElementById('studioLayersList'); if (!list || !canvas) return;
    const all = canvas.getObjects(); const objs = all.slice().reverse();
    if (!objs.length) { list.innerHTML = '<p class="studio-empty-hint">No objects yet — add shapes, text or images, or open the Library.</p>'; return; }
    const active = canvas.getActiveObjects();
    list.innerHTML = objs.map(o => {
      const idx = all.indexOf(o), sel = active.includes(o) ? 'selected' : '';
      return `<div class="studio-layer-row ${sel}" onclick="Studio.selectLayer(${idx},event)">
        <span class="studio-layer-name">${escapeHtml(layerName(o))}${o.studioLocked ? ' 🔒' : ''}</span>
        <button onclick="event.stopPropagation();Studio.toggleLayerVisibility(${idx})" title="Show / hide">${o.visible === false ? '🚫' : '👁️'}</button>
        <button onclick="event.stopPropagation();Studio.layerLock(${idx})" title="Lock / unlock">${o.studioLocked ? '🔒' : '🔓'}</button>
        <button onclick="event.stopPropagation();Studio.bringForward(${idx})" title="Bring forward">⬆️</button>
        <button onclick="event.stopPropagation();Studio.sendBackward(${idx})" title="Send backward">⬇️</button>
      </div>`;
    }).join('');
  }
  function selectLayer(i, e) {
    const o = canvas.getObjects()[i]; if (!o || o.visible === false) return;
    if (e && e.shiftKey && canvas.getActiveObject()) {
      const cur = canvas.getActiveObjects().slice(); if (!cur.includes(o)) cur.push(o);
      canvas.discardActiveObject(); canvas.setActiveObject(new fabric.ActiveSelection(cur, { canvas }));
    } else canvas.setActiveObject(o);
    canvas.requestRenderAll();
  }
  function toggleLayerVisibility(i) { const o = canvas.getObjects()[i]; if (!o) return; o.visible = o.visible === false; if (o.visible === false) canvas.discardActiveObject(); canvas.requestRenderAll(); commit(); }
  function layerLock(i) { const o = canvas.getObjects()[i]; if (!o) return; canvas.setActiveObject(o); toggleLockSelection(); }
  function bringForward(i) { const o = canvas.getObjects()[i]; if (o) { canvas.bringForward(o); commit(); } }
  function sendBackward(i) { const o = canvas.getObjects()[i]; if (o) { canvas.sendBackwards(o); commit(); } }

  // ------------------------------------------------------------------ properties panel (rendered by studio-fx.js)
  function renderProps(obj, soft) {
    const body = document.getElementById('studioPropsBody'); if (!body) return;
    // While the user is dragging a slider, re-rendering would steal focus; fx module decides via `soft`.
    if (window.StudioFx) StudioFx.render(obj, body, soft); else body.innerHTML = '';
  }
  function setProp(key, value) {
    const o = canvas.getActiveObject(); if (!o) return;
    o.set(key, value); o.setCoords(); o.dirty = true; canvas.requestRenderAll(); commit();
  }
  function setPropLive(key, value) { // no history entry (for sliders while dragging)
    const o = canvas.getActiveObject(); if (!o) return;
    o.set(key, value); o.dirty = true; canvas.requestRenderAll();
  }

  // ------------------------------------------------------------------ export
  function exportDialogOpen() {
    const m = document.getElementById('studioExportModal'); if (!m) return;
    document.getElementById('studioExpPages').style.display = pages.length > 1 ? 'block' : 'none';
    document.getElementById('studioExpPhys').textContent = designMM ? `Print size: ${designMM.w} × ${designMM.h} mm` : `${designW} × ${designH} px`;
    m.classList.add('show'); updateExportUI();
  }
  function exportDialogClose() { document.getElementById('studioExportModal').classList.remove('show'); }
  function readExportOpts() {
    const v = id => document.getElementById(id);
    const fmt = v('studioExpFormat').value, scaleSel = v('studioExpScale').value;
    const o = { format: fmt, transparent: v('studioExpTransparent').checked && fmt === 'png', quality: parseFloat(v('studioExpQuality').value), allPages: v('studioExpAllPages') && v('studioExpAllPages').checked && pages.length > 1, print: fmt === 'pdfprint' };
    let mult = 1;
    if (scaleSel === 'custom') { const cw = parseInt(v('studioExpCustomW').value) || designW; mult = cw / designW; } else mult = parseFloat(scaleSel);
    if (o.print) { const wmm = designMM ? designMM.w : designW * 25.4 / 96; mult = (wmm / 25.4 * 300) / designW; }
    o.multiplier = Math.max(0.1, mult); return o;
  }
  function updateExportUI() {
    const v = id => document.getElementById(id), fmt = v('studioExpFormat').value;
    v('studioExpTransparentRow').style.display = fmt === 'png' ? 'flex' : 'none';
    v('studioExpQualityRow').style.display = fmt === 'jpg' || fmt === 'pdf' ? 'flex' : 'none';
    v('studioExpScaleRow').style.display = fmt === 'pdfprint' ? 'none' : 'flex';
    v('studioExpCustomRow').style.display = v('studioExpScale').value === 'custom' && fmt !== 'pdfprint' ? 'flex' : 'none';
    const o = readExportOpts();
    v('studioExpInfo').textContent = `Output: ${Math.round(designW * o.multiplier)} × ${Math.round(designH * o.multiplier)} px` + (o.print ? ' (300 DPI)' : '');
  }
  function safeMultiplier(m) { // browsers refuse very large canvases (esp. phones) — cap total area
    const maxArea = 16000000, area = designW * designH * m * m; return area > maxArea ? Math.sqrt(maxArea / (designW * designH)) : m;
  }
  function renderCurrentPageURL(o) {
    const savedZ = zoomLevel, savedBg = canvas.backgroundColor, savedBgImg = canvas.backgroundImage;
    canvas.discardActiveObject();
    if (o.transparent) { canvas.backgroundColor = ''; canvas.backgroundImage = null; }
    else if (o.format === 'jpg' && !canvas.backgroundColor) canvas.backgroundColor = '#ffffff';
    canvas.setZoom(1); canvas.setDimensions({ width: designW, height: designH });
    if (o.watermark) addWatermark(o.watermark);
    canvas.renderAll();
    const fmt = (o.format === 'jpg' || o.format === 'pdf') ? 'jpeg' : 'png';
    const url = canvas.toDataURL({ format: fmt, quality: o.quality || 0.92, multiplier: safeMultiplier(o.multiplier) });
    if (o.watermark) removeWatermark();
    canvas.backgroundColor = savedBg; canvas.backgroundImage = savedBgImg; applyZoomRaw(savedZ); canvas.requestRenderAll();
    return url;
  }
  let wmObj = null;
  function addWatermark(text) {
    wmObj = new fabric.Text(text, { fontFamily: "'Manrope',sans-serif", fontWeight: '800', fontSize: Math.round(Math.min(designW, designH) * 0.06), fill: 'rgba(19,36,32,0.14)', originX: 'center', originY: 'center', left: designW / 2, top: designH / 2, angle: -22, selectable: false, evented: false, excludeFromExport: false });
    canvas.add(wmObj); canvas.bringToFront(wmObj);
  }
  function removeWatermark() { if (wmObj) { canvas.remove(wmObj); wmObj = null; } }

  async function doExport() {
    const o = readExportOpts();
    if (window.StudioStore) { const ok = await StudioStore.beforeExport(o); if (!ok) return; }
    const name = (designName || 'design').replace(/[^a-zA-Z0-9ഀ-ൿऀ-ॿ]+/g, '_');
    const savedIndex = pageIndex; storeCurrentPage();
    const urls = [];
    const targets = o.allPages ? pages.map((_, i) => i) : [pageIndex];
    for (const i of targets) {
      if (i !== pageIndex) await new Promise(res => { applyingHistory = true; pageIndex = i; canvas.loadFromJSON(pages[i], () => { applyingHistory = false; refreshText(); res(); }); });
      urls.push(renderCurrentPageURL(o));
    }
    if (pageIndex !== savedIndex) { pageIndex = savedIndex; await new Promise(res => loadPageJSON(pages[savedIndex], res)); }
    try {
      if (o.format === 'pdf' || o.format === 'pdfprint') {
        if (!(window.jspdf && window.jspdf.jsPDF)) { toast('PDF library did not load — check your internet connection', true); return; }
        const wmm = designMM ? designMM.w : designW * 25.4 / 96, hmm = designMM ? designMM.h : designH * 25.4 / 96;
        const pdf = new window.jspdf.jsPDF({ orientation: wmm >= hmm ? 'l' : 'p', unit: 'mm', format: [wmm, hmm], compress: true });
        urls.forEach((u, i) => { if (i) pdf.addPage([wmm, hmm], wmm >= hmm ? 'l' : 'p'); pdf.addImage(u, 'JPEG', 0, 0, wmm, hmm); });
        pdf.save(name + '.pdf');
      } else {
        urls.forEach((u, i) => triggerDownload(u, `${name}${urls.length > 1 ? '_p' + (i + 1) : ''}.${o.format === 'jpg' ? 'jpg' : 'png'}`));
      }
      toast('Design exported!'); exportDialogClose();
      if (window.StudioStore) StudioStore.afterExport(o);
    } catch (e) { console.error(e); toast('Export failed — try a smaller size', true); }
  }
  function triggerDownload(url, filename) {
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ------------------------------------------------------------------ keyboard shortcuts
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      const studioEl = document.getElementById('screen-studio');
      if (!studioEl || !studioEl.classList.contains('active')) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const act = canvas.getActiveObject();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (act && act.isEditing)) return;
      const ctrl = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase();
      if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (ctrl && k === 'd') { e.preventDefault(); duplicateSelection(); }
      else if (ctrl && k === 'c') { e.preventDefault(); copySelection(); }
      else if (ctrl && k === 'v') { e.preventDefault(); pasteSelection(); }
      else if (ctrl && k === 'a') { e.preventDefault(); selectAll(); }
      else if (ctrl && k === 'g' && !e.shiftKey) { e.preventDefault(); groupSelection(); }
      else if (ctrl && k === 'g' && e.shiftKey) { e.preventDefault(); ungroupSelection(); }
      else if (ctrl && k === 's') { e.preventDefault(); if (window.StudioStore) StudioStore.saveNow(); }
      else if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); }
      else if (ctrl && e.key === '-') { e.preventDefault(); zoomOut(); }
      else if (ctrl && e.key === '0') { e.preventDefault(); fitZoom(); }
      else if (e.key === ']' ) { bringForwardSel(); } else if (e.key === '[') { sendBackwardSel(); }
      else if (e.key === 'Escape') { canvas.discardActiveObject(); canvas.requestRenderAll(); closeDrawer(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (act) { e.preventDefault(); deleteSelection(); } }
      else if (e.key.startsWith('Arrow') && act) {
        e.preventDefault(); const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') act.left -= step; if (e.key === 'ArrowRight') act.left += step;
        if (e.key === 'ArrowUp') act.top -= step; if (e.key === 'ArrowDown') act.top += step;
        act.setCoords(); canvas.requestRenderAll();
        clearTimeout(arrowNudgeTimer); arrowNudgeTimer = setTimeout(commit, 350);
      }
    });
  }

  // ------------------------------------------------------------------ panel tabs & drawer
  function setPanelTab(tab) {
    panelTab = tab;
    document.querySelectorAll('.studio-panel-tab').forEach(t => t.classList.toggle('active', t.dataset.ptab === tab));
    ['design', 'layers', 'props'].forEach(n => document.getElementById('studioPanel' + n[0].toUpperCase() + n.slice(1)).classList.toggle('active', tab === n));
    if (tab === 'layers') renderLayers();
  }
  window.studioSetPanelTab = setPanelTab;
  window.studioRenameDesign = v => setName(v);

  function registerTab(t) {
    if (!tabs.find(x => x.id === t.id)) tabs.push(t);
    tabs.sort((a, b) => (a.order || 50) - (b.order || 50));
    if (booted) renderDrawerTabs();
  }
  function renderDrawerTabs() {
    const el = document.getElementById('studioDrawerTabs'); if (!el) return;
    el.innerHTML = tabs.map(t => `<button class="studio-dtab ${t.id === drawerTab ? 'active' : ''}" onclick="Studio.openDrawer('${t.id}')">${t.icon || ''} ${t.label}</button>`).join('');
  }
  function openDrawer(id) {
    const t = tabs.find(x => x.id === id) || tabs[0]; if (!t) return;
    drawerTab = t.id; document.getElementById('studioDrawer').classList.add('open'); renderDrawerTabs();
    const body = document.getElementById('studioDrawerBody'); body.scrollTop = 0; t.render(body);
    document.getElementById('screen-studio').classList.add('drawer-open');
    setTimeout(() => { if (!userZoomed) fitZoom(); }, 50);
  }
  function closeDrawer() {
    const d = document.getElementById('studioDrawer'); if (!d) return; d.classList.remove('open'); drawerTab = null;
    document.getElementById('screen-studio').classList.remove('drawer-open'); renderDrawerTabs();
    setTimeout(() => { if (!userZoomed) fitZoom(); }, 50);
  }
  function toggleDrawer() { if (drawerTab) closeDrawer(); else openDrawer(tabs[0] && tabs[0].id); }

  const publicApi = {
    enterScreen, onExit, undo, redo,
    addRect, addEllipse, addTriangle, addLine, addText, handleImageUpload,
    deleteSelection, duplicateSelection, copySelection, pasteSelection, selectAll, groupSelection, ungroupSelection, toggleLockSelection, flip,
    bringToFront, sendToBack, bringForwardSel, sendBackwardSel, align, alignEach, setPosition,
    toggleGrid, zoomIn, zoomOut, zoomReset, fitZoom, setCanvasSize: setCanvasSizeFromInputs,
    selectLayer, toggleLayerVisibility, layerLock, bringForward, sendBackward,
    setProp, setPropLive, switchPage, addPage, deletePage, movePage,
    exportDialogOpen, exportDialogClose, updateExportUI, doExport,
    registerTab, openDrawer, closeDrawer, toggleDrawer, rename: setName
  };
  // Surface for feature modules (studio-lib / fx / tpl / tools / store).
  publicApi.api = {
    canvas: () => canvas, commit, refresh: renderLayers, INCLUDE,
    size: () => ({ w: designW, h: designH, mm: designMM }), setSize, center, addObj, addImageURL, addImageFile,
    getDoc, loadDoc, loadBuilt, newDoc, specToJSON, ensureFonts, refreshText, renderProps, doc: () => ({ id: docId, name: designName, kind: docKind }),
    setDocId: id => { docId = id; }, pageCount: () => pages.length, flushSave, isBooted: () => booted, zoom: () => zoomLevel
  };
  return publicApi;
})();


// ======================= studio-lib.js =======================
// ===================================================================================
// DESIGN STUDIO — graphics library: shapes, lines, frames, stickers, icons, decorations,
// text styles, curved text, and background tools (solid / gradient / pattern / texture /
// generated images / upload / transparency).
// Depends on: studio.js (Studio.api) and Fabric.js.
// ===================================================================================
fabric.Object.prototype.strokeUniform = true; // strokes keep their width when an object is resized

var StudioLib = (() => {
  const A = () => Studio.api;
  const cv = () => A().canvas();
  const EMOJI_FONT = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";

  // ------------------------------------------------------------------ fonts
  const ENGLISH_FONTS = [
    ['Manrope', "'Manrope',sans-serif"], ['Fraunces', "'Fraunces',serif"], ['Anton', "'Anton',sans-serif"], ['Bebas Neue', "'Bebas Neue',sans-serif"],
    ['Bowlby One SC', "'Bowlby One SC',sans-serif"], ['Bungee', "'Bungee',sans-serif"], ['Bungee Shade', "'Bungee Shade',sans-serif"], ['Chango', "'Chango',sans-serif"],
    ['Coiny', "'Coiny',sans-serif"], ['Luckiest Guy', "'Luckiest Guy',sans-serif"], ['Lilita One', "'Lilita One',sans-serif"], ['Paytone One', "'Paytone One',sans-serif"],
    ['Righteous', "'Righteous',sans-serif"], ['Russo One', "'Russo One',sans-serif"], ['Titan One', "'Titan One',sans-serif"], ['Kalam (handwritten)', "'Kalam',cursive"], ['Galada', "'Galada',cursive"]
  ];
  function fontList() {
    const indian = (typeof FONT_OPTIONS !== 'undefined' ? FONT_OPTIONS : []).map(f => [f.label, f.css]);
    const seen = new Set(); const out = [];
    ENGLISH_FONTS.concat(indian).forEach(([label, css]) => { if (!seen.has(css)) { seen.add(css); out.push({ label, css }); } });
    return out;
  }
  const allFontCss = () => fontList().map(f => f.css);

  // ------------------------------------------------------------------ colour helpers
  function hexToRgb(hex) {
    hex = (hex || '#000000').replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) { const c = hexToRgb(hex); return `rgba(${c.r},${c.g},${c.b},${a == null ? 1 : a})`; }
  const toHex = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? v : (typeof v === 'string' && /^#[0-9a-f]{3}$/i.test(v) ? '#' + v.slice(1).split('').map(c => c + c).join('') : '#000000');
  function rgbaToHex(str) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(str || ''); if (!m) return null;
    return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------ shape data (100 x 100 box)
  const P = pts => pts.map(p => p.join(',')).join(' ');
  function polyPath(pts) { return 'M' + pts.map(p => p.join(' ')).join(' L') + ' Z'; }
  function starPts(n, inner, rot) {
    const out = []; rot = rot == null ? -Math.PI / 2 : rot;
    for (let i = 0; i < n * 2; i++) { const r = (i % 2 ? inner : 1) * 50, a = rot + Math.PI * i / n; out.push([+(50 + Math.cos(a) * r).toFixed(2), +(50 + Math.sin(a) * r).toFixed(2)]); }
    return out;
  }
  function regPts(n, rot) {
    const out = []; rot = rot == null ? -Math.PI / 2 : rot;
    for (let i = 0; i < n; i++) { const a = rot + 2 * Math.PI * i / n; out.push([+(50 + Math.cos(a) * 50).toFixed(2), +(50 + Math.sin(a) * 50).toFixed(2)]); }
    return out;
  }
  function scallopPath(n, R, bulge) { // flower / scalloped seal built from arcs
    const pts = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + 2 * Math.PI * i / n; pts.push([50 + Math.cos(a) * R, 50 + Math.sin(a) * R]); }
    const chord = 2 * R * Math.sin(Math.PI / n), r = chord / 2 * (bulge || 1.0);
    let d = 'M' + pts[0].map(v => v.toFixed(2)).join(' ');
    for (let i = 1; i <= n; i++) { const p = pts[i % n]; d += ` A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${p[0].toFixed(2)} ${p[1].toFixed(2)}`; }
    return d + ' Z';
  }
  // Each entry: {id,label,cat,d (svg path in 0..100), rule?}
  const SHAPE_DATA = [
    { id: 'triangle', label: 'Triangle', cat: 'Basic', d: polyPath([[50, 0], [100, 100], [0, 100]]) },
    { id: 'rtriangle', label: 'Right triangle', cat: 'Basic', d: polyPath([[0, 0], [0, 100], [100, 100]]) },
    { id: 'diamond', label: 'Diamond', cat: 'Basic', d: polyPath([[50, 0], [100, 50], [50, 100], [0, 50]]) },
    { id: 'pentagon', label: 'Pentagon', cat: 'Basic', d: polyPath(regPts(5)) },
    { id: 'hexagon', label: 'Hexagon', cat: 'Basic', d: polyPath([[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]]) },
    { id: 'octagon', label: 'Octagon', cat: 'Basic', d: polyPath(regPts(8, -Math.PI / 8)) },
    { id: 'parallelogram', label: 'Parallelogram', cat: 'Basic', d: polyPath([[22, 0], [100, 0], [78, 100], [0, 100]]) },
    { id: 'trapezoid', label: 'Trapezoid', cat: 'Basic', d: polyPath([[20, 0], [80, 0], [100, 100], [0, 100]]) },
    { id: 'semicircle', label: 'Semicircle', cat: 'Basic', d: 'M0 100 A50 50 0 0 1 100 100 Z' },
    { id: 'arch', label: 'Arch', cat: 'Basic', d: 'M0 100 L0 50 A50 50 0 0 1 100 50 L100 100 Z' },
    { id: 'ring', label: 'Ring', cat: 'Basic', d: 'M50 0 A50 50 0 1 0 50 100 A50 50 0 1 0 50 0 Z M50 22 A28 28 0 1 1 50 78 A28 28 0 1 1 50 22 Z', rule: 'evenodd' },
    { id: 'cross', label: 'Plus', cat: 'Basic', d: polyPath([[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]]) },
    { id: 'star5', label: 'Star', cat: 'Stars', d: polyPath(starPts(5, 0.42)) },
    { id: 'star4', label: 'Sparkle', cat: 'Stars', d: polyPath(starPts(4, 0.28)) },
    { id: 'star6', label: '6-point star', cat: 'Stars', d: polyPath(starPts(6, 0.55)) },
    { id: 'star8', label: '8-point star', cat: 'Stars', d: polyPath(starPts(8, 0.6)) },
    { id: 'burst12', label: 'Burst', cat: 'Stars', d: polyPath(starPts(12, 0.78)) },
    { id: 'burst16', label: 'Sale burst', cat: 'Stars', d: polyPath(starPts(16, 0.8)) },
    { id: 'seal24', label: 'Seal', cat: 'Stars', d: polyPath(starPts(24, 0.92)) },
    { id: 'scallop', label: 'Scallop badge', cat: 'Stars', d: scallopPath(10, 38, 1.0) },
    { id: 'flower8', label: 'Flower', cat: 'Stars', d: scallopPath(8, 36, 1.12) },
    { id: 'arrowR', label: 'Arrow right', cat: 'Arrows', d: polyPath([[0, 30], [60, 30], [60, 0], [100, 50], [60, 100], [60, 70], [0, 70]]) },
    { id: 'arrowL', label: 'Arrow left', cat: 'Arrows', d: polyPath([[100, 30], [40, 30], [40, 0], [0, 50], [40, 100], [40, 70], [100, 70]]) },
    { id: 'arrowU', label: 'Arrow up', cat: 'Arrows', d: polyPath([[30, 100], [30, 40], [0, 40], [50, 0], [100, 40], [70, 40], [70, 100]]) },
    { id: 'arrowD', label: 'Arrow down', cat: 'Arrows', d: polyPath([[30, 0], [30, 60], [0, 60], [50, 100], [100, 60], [70, 60], [70, 0]]) },
    { id: 'chevronR', label: 'Chevron', cat: 'Arrows', d: polyPath([[0, 0], [60, 0], [100, 50], [60, 100], [0, 100], [40, 50]]) },
    { id: 'chevronL', label: 'Chevron left', cat: 'Arrows', d: polyPath([[100, 0], [40, 0], [0, 50], [40, 100], [100, 100], [60, 50]]) },
    { id: 'arrowCurve', label: 'Curved arrow', cat: 'Arrows', d: 'M5 80 C5 30 45 20 70 25 L70 5 L100 35 L70 65 L70 45 C45 40 30 50 30 80 Z' },
    { id: 'heart', label: 'Heart', cat: 'Fun', d: 'M50 92 C10 62 0 42 0 28 C0 10 14 2 27 2 C37 2 46 8 50 16 C54 8 63 2 73 2 C86 2 100 10 100 28 C100 42 90 62 50 92 Z' },
    { id: 'drop', label: 'Drop', cat: 'Fun', d: 'M50 2 C50 2 90 45 90 65 C90 85 72 98 50 98 C28 98 10 85 10 65 C10 45 50 2 50 2 Z' },
    { id: 'moon', label: 'Crescent', cat: 'Fun', d: 'M84 13.3 A50 50 0 1 0 84 86.7 A40 40 0 1 1 84 13.3 Z' },
    { id: 'leaf', label: 'Leaf', cat: 'Fun', d: 'M8 92 C8 40 40 8 92 8 C92 60 60 92 8 92 Z' },
    { id: 'cloud', label: 'Cloud', cat: 'Fun', d: 'M25 80 C8 80 2 60 18 52 C14 32 36 24 46 36 C54 18 82 22 82 42 C98 44 100 80 78 80 Z' },
    { id: 'wave', label: 'Wave band', cat: 'Fun', d: 'M0 35 C20 5 30 5 50 35 C70 65 80 65 100 35 L100 70 C80 100 70 100 50 70 C30 40 20 40 0 70 Z' },
    { id: 'blob', label: 'Blob', cat: 'Fun', d: 'M50 5 C75 0 98 22 95 48 C93 75 72 98 46 95 C20 92 2 72 5 46 C8 22 28 8 50 5 Z' },
    { id: 'blob2', label: 'Blob 2', cat: 'Fun', d: 'M30 8 C55 -4 90 10 96 40 C102 70 76 96 46 94 C16 92 -4 66 6 40 C10 26 18 14 30 8 Z' },
    { id: 'lightning', label: 'Lightning', cat: 'Fun', d: polyPath([[58, 0], [12, 56], [44, 56], [34, 100], [88, 40], [54, 40]]) },
    { id: 'speech', label: 'Speech bubble', cat: 'Labels', d: 'M10 5 H90 Q100 5 100 15 V60 Q100 70 90 70 H45 L25 95 L28 70 H10 Q0 70 0 60 V15 Q0 5 10 5 Z' },
    { id: 'tag', label: 'Price tag', cat: 'Labels', d: polyPath([[0, 0], [72, 0], [100, 50], [72, 100], [0, 100]]) },
    { id: 'ribbon', label: 'Ribbon', cat: 'Labels', d: polyPath([[0, 10], [100, 10], [88, 50], [100, 90], [0, 90], [12, 50]]) },
    { id: 'pennant', label: 'Pennant', cat: 'Labels', d: polyPath([[0, 0], [100, 0], [100, 100], [50, 70], [0, 100]]) },
    { id: 'ticket', label: 'Ticket', cat: 'Labels', d: 'M0 10 H100 V38 A12 12 0 0 0 100 62 V90 H0 V62 A12 12 0 0 0 0 38 Z' },
    { id: 'house', label: 'House', cat: 'Labels', d: polyPath([[50, 0], [100, 42], [88, 42], [88, 100], [12, 100], [12, 42], [0, 42]]) },
    { id: 'shield', label: 'Shield', cat: 'Labels', d: 'M50 0 L100 14 V50 C100 78 76 94 50 100 C24 94 0 78 0 50 V14 Z' },
    { id: 'pin', label: 'Location pin', cat: 'Labels', d: 'M50 98 C50 98 10 58 10 36 C10 14 28 2 50 2 C72 2 90 14 90 36 C90 58 50 98 50 98 Z M50 22 A14 14 0 1 0 50 50 A14 14 0 1 0 50 22 Z', rule: 'evenodd' }
  ];

  function makeShape(id, fill) {
    const def = SHAPE_DATA.find(s => s.id === id); if (!def) return null;
    const p = new fabric.Path(def.d, { fill: fill || '#0E6E5D', fillRule: def.rule || 'nonzero', studioKind: 'shape', studioName: def.label });
    const s = 240 / Math.max(p.width, p.height); p.set({ scaleX: s, scaleY: s });
    return p;
  }
  function addShape(id) { const o = makeShape(id); if (o) A().addObj(o); }
  function addRoundedRect() { A().addObj(new fabric.Rect({ width: 240, height: 160, rx: 28, ry: 28, fill: '#0E6E5D', studioKind: 'rect', studioName: 'Rounded rectangle' })); }
  function addSquare() { A().addObj(new fabric.Rect({ width: 200, height: 200, fill: '#0E6E5D', studioKind: 'rect', studioName: 'Square' })); }
  function addCircle() { A().addObj(new fabric.Circle({ radius: 100, fill: '#CC9A3C', studioKind: 'ellipse', studioName: 'Circle' })); }

  // ------------------------------------------------------------------ lines & arrows
  function lineObj(opts) { return new fabric.Line([-150, 0, 150, 0], Object.assign({ stroke: '#152420', strokeWidth: 6, strokeLineCap: 'round', studioKind: 'line' }, opts)); }
  function addLineStyle(kind) {
    let o;
    if (kind === 'solid') o = lineObj({ studioName: 'Line' });
    else if (kind === 'dashed') o = lineObj({ strokeDashArray: [18, 12], strokeLineCap: 'butt', studioName: 'Dashed line' });
    else if (kind === 'dotted') o = lineObj({ strokeDashArray: [1, 14], strokeWidth: 8, studioName: 'Dotted line' });
    else if (kind === 'thick') o = lineObj({ strokeWidth: 20, strokeLineCap: 'butt', studioName: 'Bar' });
    else if (kind === 'arrow' || kind === 'double') {
      const ln = new fabric.Line([-140, 0, 120, 0], { stroke: '#152420', strokeWidth: 6, strokeLineCap: 'round' });
      const head = n => new fabric.Triangle({ width: 30, height: 30, fill: '#152420', originX: 'center', originY: 'center', left: n * 135, top: 0, angle: n > 0 ? 90 : -90 });
      o = new fabric.Group(kind === 'arrow' ? [ln, head(1)] : [ln, head(1), head(-1)], { studioKind: 'multi', studioName: kind === 'arrow' ? 'Arrow' : 'Double arrow' });
    }
    if (o) A().addObj(o);
  }

  // ------------------------------------------------------------------ frames & borders (sized to the page)
  function addFrame(kind) {
    const { w, h } = A().size(), m = Math.min(w, h) * 0.04, W = w - m * 2, H = h - m * 2, col = '#152420';
    const base = { fill: 'transparent', stroke: col, strokeWidth: Math.max(4, Math.min(w, h) * 0.006), studioKind: 'frame' };
    let o;
    if (kind === 'thin') o = new fabric.Rect(Object.assign({ width: W, height: H, studioName: 'Border' }, base));
    else if (kind === 'thick') o = new fabric.Rect(Object.assign({ width: W, height: H, studioName: 'Thick border' }, base, { strokeWidth: Math.min(w, h) * 0.025 }));
    else if (kind === 'rounded') o = new fabric.Rect(Object.assign({ width: W, height: H, rx: Math.min(w, h) * 0.05, ry: Math.min(w, h) * 0.05, studioName: 'Rounded border' }, base));
    else if (kind === 'dashed') o = new fabric.Rect(Object.assign({ width: W, height: H, strokeDashArray: [22, 14], studioName: 'Dashed border' }, base));
    else if (kind === 'double') {
      const a = new fabric.Rect(Object.assign({ width: W, height: H }, base)), g = m * 0.55;
      const b = new fabric.Rect(Object.assign({ width: W - g * 2, height: H - g * 2, left: g, top: g }, base, { strokeWidth: base.strokeWidth * 0.6 }));
      o = new fabric.Group([a, b], { studioKind: 'multi', studioName: 'Double border' });
    } else if (kind === 'corners') {
      const L = Math.min(W, H) * 0.14, sw = base.strokeWidth * 1.6, mk = d => new fabric.Path(d, { fill: '', stroke: col, strokeWidth: sw, strokeLineCap: 'square' });
      o = new fabric.Group([mk(`M0 ${L} L0 0 L${L} 0`), mk(`M${W - L} 0 L${W} 0 L${W} ${L}`), mk(`M0 ${H - L} L0 ${H} L${L} ${H}`), mk(`M${W - L} ${H} L${W} ${H} L${W} ${H - L}`)].map((p, i) => { p.set({ left: [0, W - L, 0, W - L][i], top: [0, 0, H - L, H - L][i] }); return p; }), { studioKind: 'multi', studioName: 'Corner frame' });
    } else if (kind === 'circle') { const r = Math.min(W, H) / 2; o = new fabric.Circle(Object.assign({ radius: r, studioName: 'Circle frame' }, base)); }
    else if (kind === 'polaroid') {
      const pw = Math.min(w, h) * 0.62, ph = pw * 1.18;
      const card = new fabric.Rect({ width: pw, height: ph, fill: '#ffffff', shadow: new fabric.Shadow({ color: 'rgba(0,0,0,.28)', blur: 24, offsetX: 0, offsetY: 8 }) });
      const win = new fabric.Rect({ width: pw * 0.88, height: pw * 0.88, left: pw * 0.06, top: pw * 0.06, fill: '#e5e0d2' });
      o = new fabric.Group([card, win], { studioKind: 'multi', studioName: 'Photo frame' });
    }
    if (o) A().addObj(o);
  }

  // ------------------------------------------------------------------ stickers / icons
  const STICKERS = {
    Festival: '🪔 🎆 🎇 🎉 🎊 🎁 🎈 🎂 🪅 🧨 ✨ 🌟 🎄 🎅 🕯️ 🪁 🌸 🌼 🌺 🪷 🐘 🥁 🎶 🏮 🥥 🌾 🍯 🎑'.split(' '),
    Islamic: '🕌 🌙 ⭐ 🕋 🤲 📿 🌴 🕯️ 🏮 🌟 ✨ 🕊️ 🌹 🍇 🥛 🫖'.split(' '),
    Sale: '🔥 💥 🎁 💯 🆕 🏷️ 💸 🛍️ 🎟️ ⚡ ❗ 🎯 🏆 🤩 😍 👍 🔔 📣 ⏰ 🆓'.split(' '),
    Food: '🍔 🍕 🍟 🌭 🍗 🍖 🍛 🍜 🍲 🥘 🍚 🍰 🧁 🍩 🍦 🥤 ☕ 🍉 🍎 🍌 🥭 🍇 🍓 🍅 🥦 🧀 🥗 🌮 🍣 🥟 🍪 🍫'.split(' '),
    Fashion: '👗 👕 👖 👔 👠 👟 👜 👓 🧢 👑 💍 💄 👒 🧥 🕶️ 👚 🩳 🧣 🧤 🎒 💎 ⌚'.split(' '),
    Business: '💼 📈 📊 💰 💳 🛒 📞 📱 💻 📧 📍 🔔 ✅ ⭐ 🏆 🎯 🤝 💡 🚚 📦 🏠 🔑 🏥 🎓 📚 🛠️ 🚗 ✂️ 💇 💅'.split(' '),
    Nature: '🌿 🍃 🌺 🌻 🌷 🌴 🌈 ☀️ 🌤️ ⛅ 🌧️ ❄️ 🔥 💧 🐦 🦋 🐝 🐾 🌊 ⛰️'.split(' ')
  };
  const SOCIAL = [
    { id: 'wa', label: 'WhatsApp', bg: '#25D366', glyph: '📞', shape: 'circle' }, { id: 'ig', label: 'Instagram', bg: '#C13584', glyph: '📷', shape: 'round' },
    { id: 'fb', label: 'Facebook', bg: '#1877F2', glyph: 'f', shape: 'circle', bold: true }, { id: 'yt', label: 'YouTube', bg: '#FF0000', glyph: '▶', shape: 'round' },
    { id: 'tg', label: 'Telegram', bg: '#229ED9', glyph: '✈', shape: 'circle' }, { id: 'x', label: 'X / Twitter', bg: '#111111', glyph: '𝕏', shape: 'round' },
    { id: 'in', label: 'LinkedIn', bg: '#0A66C2', glyph: 'in', shape: 'round', bold: true }, { id: 'call', label: 'Call', bg: '#0E6E5D', glyph: '📞', shape: 'circle' },
    { id: 'mail', label: 'Email', bg: '#E1553B', glyph: '✉', shape: 'circle' }, { id: 'web', label: 'Website', bg: '#4F46E5', glyph: '🌐', shape: 'circle' },
    { id: 'map', label: 'Location', bg: '#DC2626', glyph: '📍', shape: 'circle' }, { id: 'clock', label: 'Timing', bg: '#CC9A3C', glyph: '🕒', shape: 'circle' }
  ];
  function addEmoji(ch) {
    A().addObj(new fabric.Text(ch, { fontSize: 180, fontFamily: EMOJI_FONT, studioKind: 'emoji', studioName: 'Sticker ' + ch }));
  }
  function addSocialBadge(id) {
    const s = SOCIAL.find(x => x.id === id); if (!s) return;
    const sz = 140;
    const bgShape = s.shape === 'circle' ? new fabric.Circle({ radius: sz / 2, fill: s.bg, originX: 'center', originY: 'center' }) : new fabric.Rect({ width: sz, height: sz, rx: 34, ry: 34, fill: s.bg, originX: 'center', originY: 'center' });
    const gl = new fabric.Text(s.glyph, { fontSize: s.glyph.length > 1 && !/[\u{1F300}-\u{1FAFF}]/u.test(s.glyph) ? 64 : 70, fontFamily: s.bold ? "'Manrope',sans-serif" : EMOJI_FONT, fontWeight: '800', fill: '#ffffff', originX: 'center', originY: 'center' });
    A().addObj(new fabric.Group([bgShape, gl], { studioKind: 'multi', studioName: s.label + ' icon' }));
  }
  function addAdminSticker(url) { A().addImageURL(url, { fill: 0.4 }); }

  // ------------------------------------------------------------------ decorative graphics
  function rand(seed) { let s = seed || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
  const PALETTE = ['#E1553B', '#CC9A3C', '#0E6E5D', '#4F46E5', '#DB2777', '#0EA5E9', '#F59E0B'];
  function addDecor(kind) {
    const { w, h } = A().size(), r = rand(Date.now() % 100000 + 7); let o;
    if (kind === 'confetti') {
      const items = []; const n = 70;
      for (let i = 0; i < n; i++) {
        const c = PALETTE[Math.floor(r() * PALETTE.length)], x = (r() - 0.5) * w, y = (r() - 0.5) * h, sz = 10 + r() * 22, k = Math.floor(r() * 3);
        const it = k === 0 ? new fabric.Rect({ width: sz, height: sz * 0.45, fill: c }) : k === 1 ? new fabric.Circle({ radius: sz * 0.35, fill: c }) : new fabric.Triangle({ width: sz, height: sz, fill: c });
        it.set({ left: x, top: y, angle: r() * 360, originX: 'center', originY: 'center' }); items.push(it);
      }
      o = new fabric.Group(items, { studioKind: 'multi', studioName: 'Confetti' });
    } else if (kind === 'dots') {
      const items = [], gap = Math.min(w, h) / 14, cols = 8, rows = 5;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) items.push(new fabric.Circle({ radius: gap * 0.16, fill: '#CC9A3C', left: i * gap, top: j * gap }));
      o = new fabric.Group(items, { studioKind: 'multi', studioName: 'Dot grid' });
    } else if (kind === 'sunburst') {
      const items = [], n = 24, R = Math.hypot(w, h) / 2;
      for (let i = 0; i < n; i += 2) {
        const a1 = (i / n) * Math.PI * 2, a2 = ((i + 1) / n) * Math.PI * 2;
        items.push(new fabric.Polygon([{ x: 0, y: 0 }, { x: Math.cos(a1) * R, y: Math.sin(a1) * R }, { x: Math.cos(a2) * R, y: Math.sin(a2) * R }], { fill: 'rgba(255,255,255,0.22)', originX: 'left', originY: 'top', left: Math.min(0, Math.cos(a1) * R, Math.cos(a2) * R), top: Math.min(0, Math.sin(a1) * R, Math.sin(a2) * R) }));
      }
      o = new fabric.Group(items, { studioKind: 'multi', studioName: 'Sunburst rays' });
    } else if (kind === 'wave') {
      o = new fabric.Path(`M0 40 C${w * 0.2} 0 ${w * 0.3} 0 ${w * 0.5} 40 C${w * 0.7} 80 ${w * 0.8} 80 ${w} 40 L${w} ${h * 0.22} L0 ${h * 0.22} Z`, { fill: '#0E6E5D', studioKind: 'shape', studioName: 'Wave footer' });
      o.set({ left: w / 2, top: h - o.height / 2, originX: 'center', originY: 'center' }); canvasAddKeepPos(o); return;
    } else if (kind === 'corner') {
      const s = Math.min(w, h) * 0.35;
      o = new fabric.Path(`M0 0 L${s} 0 C${s * 0.55} ${s * 0.12} ${s * 0.12} ${s * 0.55} 0 ${s} Z`, { fill: '#CC9A3C', studioKind: 'shape', studioName: 'Corner ornament' });
      o.set({ left: o.width / 2, top: o.height / 2, originX: 'center', originY: 'center' }); canvasAddKeepPos(o); return;
    } else if (kind === 'stripes') {
      const items = []; for (let i = 0; i < 12; i++) items.push(new fabric.Rect({ width: w * 1.6, height: 26, fill: i % 2 ? '#CC9A3C' : '#0E6E5D', left: 0, top: i * 26 }));
      o = new fabric.Group(items, { studioKind: 'multi', studioName: 'Stripe band', angle: -12 });
    } else if (kind === 'islamicStar') {
      const s = Math.min(w, h) * 0.35;
      const sq = a => new fabric.Rect({ width: s, height: s, fill: 'transparent', stroke: '#CC9A3C', strokeWidth: 5, originX: 'center', originY: 'center', left: 0, top: 0, angle: a });
      o = new fabric.Group([sq(0), sq(45)], { studioKind: 'multi', studioName: '8-point star' });
    } else if (kind === 'rosette') {
      const items = [], s = Math.min(w, h) * 0.16;
      for (let i = 0; i < 8; i++) items.push(new fabric.Ellipse({ rx: s, ry: s * 0.42, fill: 'transparent', stroke: '#CC9A3C', strokeWidth: 4, originX: 'center', originY: 'center', left: 0, top: 0, angle: i * 22.5 }));
      o = new fabric.Group(items, { studioKind: 'multi', studioName: 'Geometric rosette' });
    } else if (kind === 'mihrab') {
      const ww = Math.min(w, h) * 0.5, hh = ww * 1.5;
      o = new fabric.Path(`M0 ${hh} L0 ${ww * 0.55} C0 ${ww * 0.2} ${ww * 0.35} ${ww * 0.12} ${ww / 2} 0 C${ww * 0.65} ${ww * 0.12} ${ww} ${ww * 0.2} ${ww} ${ww * 0.55} L${ww} ${hh} Z`, { fill: 'transparent', stroke: '#CC9A3C', strokeWidth: 8, studioKind: 'shape', studioName: 'Islamic arch' });
    } else if (kind === 'crescentStar') {
      const m = makeShape('moon', '#CC9A3C'), st = makeShape('star5', '#CC9A3C'); m.scaleToWidth(150); st.scaleToWidth(54);
      m.set({ originX: 'center', originY: 'center', left: 0, top: 0 }); st.set({ originX: 'center', originY: 'center', left: 62, top: -6 });
      o = new fabric.Group([m, st], { studioKind: 'multi', studioName: 'Crescent & star' });
    }
    if (o) A().addObj(o);
  }
  function canvasAddKeepPos(o) { const c = cv(); c.add(o); c.setActiveObject(o); c.requestRenderAll(); A().commit(); }

  // ------------------------------------------------------------------ text styles
  const TEXT_STYLES = [
    { label: 'Heading', text: 'Your Heading', fontFamily: "'Fraunces',serif", fontWeight: '900', fontSize: 120, fill: '#152420' },
    { label: 'Subheading', text: 'Your subheading here', fontFamily: "'Manrope',sans-serif", fontWeight: '700', fontSize: 64, fill: '#152420' },
    { label: 'Body text', text: 'Write something about your business, product or event.', fontFamily: "'Manrope',sans-serif", fontWeight: '400', fontSize: 36, fill: '#334155', box: true },
    { label: 'BIG SALE', text: 'BIG SALE', fontFamily: "'Anton',sans-serif", fontSize: 200, fill: '#E1553B', stroke: '#ffffff', strokeWidth: 8, shadow: { color: 'rgba(0,0,0,.35)', blur: 0, offsetX: 8, offsetY: 8 }, charSpacing: 40 },
    { label: 'Neon', text: 'NEON', fontFamily: "'Righteous',sans-serif", fontSize: 160, fill: '#67E8F9', shadow: { color: '#22D3EE', blur: 28, offsetX: 0, offsetY: 0 } },
    { label: 'Gold gradient', text: 'Premium', fontFamily: "'Fraunces',serif", fontWeight: '900', fontSize: 170, gradient: ['#F7E08A', '#B8860B'] },
    { label: 'Outline', text: 'OUTLINE', fontFamily: "'Bebas Neue',sans-serif", fontSize: 200, fill: 'rgba(0,0,0,0)', stroke: '#152420', strokeWidth: 5, charSpacing: 60 },
    { label: '3D block', text: 'POP!', fontFamily: "'Bungee',sans-serif", fontSize: 180, fill: '#FACC15', stroke: '#152420', strokeWidth: 6, shadow: { color: '#152420', blur: 0, offsetX: 10, offsetY: 10 } },
    { label: 'Retro', text: 'Retro Vibes', fontFamily: "'Chango',sans-serif", fontSize: 130, fill: '#F97316', shadow: { color: '#7C2D12', blur: 0, offsetX: 6, offsetY: 6 } },
    { label: 'Label', text: ' OFFER ', fontFamily: "'Paytone One',sans-serif", fontSize: 100, fill: '#ffffff', textBackgroundColor: '#E1553B' },
    { label: 'Handwritten', text: 'Handwritten note', fontFamily: "'Kalam',cursive", fontSize: 90, fill: '#152420' },
    { label: 'മലയാളം ഓഫർ', text: 'മെഗാ ഓഫർ', fontFamily: "'Baloo Chettan 2','Noto Sans Malayalam',sans-serif", fontWeight: '800', fontSize: 170, fill: '#E1553B', stroke: '#ffffff', strokeWidth: 6, shadow: { color: 'rgba(0,0,0,.3)', blur: 0, offsetX: 6, offsetY: 6 } },
    { label: 'हिंदी बोल्ड', text: 'बड़ी सेल', fontFamily: "'Baloo 2','Noto Sans Devanagari',sans-serif", fontWeight: '800', fontSize: 170, fill: '#DC2626' },
    { label: 'தமிழ் போல்ட்', text: 'சிறப்பு தள்ளுபடி', fontFamily: "'Baloo Thambi 2','Noto Sans Tamil',sans-serif", fontWeight: '800', fontSize: 120, fill: '#0E6E5D' }
  ];
  function textGradient(c1, c2) {
    return new fabric.Gradient({ type: 'linear', gradientUnits: 'percentage', coords: { x1: 0, y1: 0, x2: 0, y2: 1 }, colorStops: [{ offset: 0, color: c1 }, { offset: 1, color: c2 }] });
  }
  async function addTextStyle(i) {
    const s = TEXT_STYLES[i]; if (!s) return;
    await A().ensureFonts([s.fontFamily], s.text);
    const opts = { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight || 'normal', fill: s.gradient ? textGradient(s.gradient[0], s.gradient[1]) : s.fill, textAlign: 'center', studioKind: 'text', paintFirst: 'stroke' };
    if (s.stroke) { opts.stroke = s.stroke; opts.strokeWidth = s.strokeWidth; opts.strokeLineJoin = 'round'; }
    if (s.shadow) opts.shadow = new fabric.Shadow(s.shadow);
    if (s.charSpacing) opts.charSpacing = s.charSpacing;
    if (s.textBackgroundColor) opts.textBackgroundColor = s.textBackgroundColor;
    let o;
    if (s.box) { opts.width = A().size().w * 0.7; o = new fabric.Textbox(s.text, opts); } else o = new fabric.IText(s.text, opts);
    // keep very large presets inside the page
    const maxW = A().size().w * 0.92; if (o.width > maxW) o.scaleToWidth(maxW);
    A().addObj(o);
  }

  // ------------------------------------------------------------------ curved text
  function graphemes(str) {
    try { if (Intl && Intl.Segmenter) return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str), s => s.segment); } catch (e) { /* fall through */ }
    return Array.from(str);
  }
  // spec: {text, curve (-100..100), fontSize, fontFamily, fontWeight, fill, spacing, stroke, strokeWidth}
  function buildCurvedGroup(spec) {
    const chars = graphemes(spec.text || ' '), n = chars.length;
    const mk = ch => new fabric.Text(ch, { fontFamily: spec.fontFamily, fontSize: spec.fontSize, fontWeight: spec.fontWeight || 'normal', fill: spec.fill, stroke: spec.stroke || null, strokeWidth: spec.stroke ? (spec.strokeWidth || 0) : 0, paintFirst: 'stroke', originX: 'center', originY: 'center' });
    const objs = chars.map(mk), spacing = spec.spacing || 0;
    const widths = objs.map(o => o.width || spec.fontSize * 0.5), total = widths.reduce((a, b) => a + b, 0) + spacing * (n - 1);
    const curve = Math.max(-100, Math.min(100, spec.curve || 0));
    if (Math.abs(curve) < 1) {
      let x = -total / 2; objs.forEach((o, i) => { o.set({ left: x + widths[i] / 2, top: 0, angle: 0 }); x += widths[i] + spacing; });
    } else {
      const theta = Math.abs(curve) / 100 * Math.PI * 1.7, R = total / theta; let acc = 0;
      objs.forEach((o, i) => {
        const mid = acc + widths[i] / 2; acc += widths[i] + spacing; const phi = mid / R - theta / 2;
        if (curve > 0) o.set({ left: R * Math.sin(phi), top: -R * Math.cos(phi) + R, angle: phi * 180 / Math.PI });
        else o.set({ left: R * Math.sin(phi), top: R * Math.cos(phi) - R, angle: -phi * 180 / Math.PI });
      });
    }
    const g = new fabric.Group(objs, { studioKind: 'curved', studioName: '⌒ ' + (spec.text || '').slice(0, 16), studioCurve: Object.assign({}, spec), subTargetCheck: false });
    return g;
  }
  async function addCurvedText(curve) {
    const spec = { text: 'CURVED TEXT', curve: curve, fontSize: 90, fontFamily: "'Anton',sans-serif", fontWeight: 'normal', fill: '#152420', spacing: 4 };
    await A().ensureFonts([spec.fontFamily], spec.text);
    const g = buildCurvedGroup(spec); A().addObj(g);
  }
  // Rebuild an existing curved-text group with changed settings (keeps position, angle, stacking).
  function updateCurved(obj, patch) {
    const c = cv(); if (!obj || !obj.studioCurve) return obj;
    const spec = Object.assign({}, obj.studioCurve, patch), idx = c.getObjects().indexOf(obj), ctr = obj.getCenterPoint();
    const g = buildCurvedGroup(spec);
    g.set({ originX: 'center', originY: 'center', left: ctr.x, top: ctr.y, angle: obj.angle || 0, flipX: obj.flipX, flipY: obj.flipY, opacity: obj.opacity, shadow: obj.shadow });
    if (obj.scaleX && Math.abs(obj.scaleX - 1) > 0.001) { /* scale is baked into font size by the user via the Size field */ }
    c.remove(obj); c.insertAt(g, idx, false); c.setActiveObject(g); c.requestRenderAll(); return g;
  }

  // ------------------------------------------------------------------ backgrounds
  const GRADIENTS = [
    ['#0E6E5D', '#14B8A6', 135], ['#E1553B', '#F59E0B', 135], ['#4F46E5', '#DB2777', 135], ['#0EA5E9', '#6366F1', 160], ['#111827', '#374151', 180],
    ['#FDE68A', '#F59E0B', 180], ['#F472B6', '#FB923C', 120], ['#22C55E', '#065F46', 160], ['#7C3AED', '#2563EB', 135], ['#FBF6EA', '#F3ECDA', 180],
    ['#152420', '#0E6E5D', 135], ['#FEE2E2', '#FCA5A5', 180]
  ];
  function makeGradient(c1, c2, angle, W, H, alpha) {
    const th = (angle == null ? 180 : angle) * Math.PI / 180, vx = Math.sin(th), vy = -Math.cos(th);
    const L = Math.abs(W * vx) + Math.abs(H * vy), cx = W / 2, cy = H / 2;
    return new fabric.Gradient({ type: 'linear', gradientUnits: 'pixels', coords: { x1: cx - vx * L / 2, y1: cy - vy * L / 2, x2: cx + vx * L / 2, y2: cy + vy * L / 2 }, colorStops: [{ offset: 0, color: alpha != null && alpha < 1 ? rgba(c1, alpha) : c1 }, { offset: 1, color: alpha != null && alpha < 1 ? rgba(c2, alpha) : c2 }] });
  }
  // Pattern tiles are drawn on small canvases with plain 2D code.
  const PATTERNS = [
    { id: 'dots', label: 'Polka dots' }, { id: 'stripes', label: 'Stripes' }, { id: 'checks', label: 'Checks' }, { id: 'grid', label: 'Grid' },
    { id: 'diagonal', label: 'Diagonal' }, { id: 'zigzag', label: 'Zigzag' }, { id: 'waves', label: 'Waves' }, { id: 'hex', label: 'Hexagons' },
    { id: 'islamic', label: 'Islamic star' }, { id: 'plus', label: 'Plus' }
  ];
  function tile(id, c1, c2, alpha) {
    const S = 80, c = document.createElement('canvas'); c.width = S; c.height = S; const x = c.getContext('2d');
    x.fillStyle = rgba(c1, alpha); x.fillRect(0, 0, S, S); x.strokeStyle = rgba(c2, alpha); x.fillStyle = rgba(c2, alpha); x.lineWidth = 4;
    if (id === 'dots') { x.beginPath(); x.arc(20, 20, 9, 0, 7); x.fill(); x.beginPath(); x.arc(60, 60, 9, 0, 7); x.fill(); }
    else if (id === 'stripes') { x.fillRect(0, 0, S, 20); x.fillRect(0, 40, S, 20); }
    else if (id === 'checks') { x.fillRect(0, 0, 40, 40); x.fillRect(40, 40, 40, 40); }
    else if (id === 'grid') { x.lineWidth = 2; x.strokeRect(0, 0, S, S); }
    else if (id === 'diagonal') { x.lineWidth = 8; x.beginPath(); x.moveTo(-10, 90); x.lineTo(90, -10); x.moveTo(-50, 50); x.lineTo(50, -50); x.moveTo(30, 130); x.lineTo(130, 30); x.stroke(); }
    else if (id === 'zigzag') { x.lineWidth = 6; x.beginPath(); x.moveTo(0, 50); x.lineTo(20, 30); x.lineTo(40, 50); x.lineTo(60, 30); x.lineTo(80, 50); x.stroke(); }
    else if (id === 'waves') { x.lineWidth = 5; x.beginPath(); x.moveTo(0, 40); x.bezierCurveTo(20, 10, 20, 10, 40, 40); x.bezierCurveTo(60, 70, 60, 70, 80, 40); x.stroke(); }
    else if (id === 'hex') { x.lineWidth = 3; x.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i; x[i ? 'lineTo' : 'moveTo'](40 + 28 * Math.cos(a), 40 + 28 * Math.sin(a)); } x.closePath(); x.stroke(); }
    else if (id === 'islamic') { x.lineWidth = 3; [0, Math.PI / 4].forEach(rot => { x.save(); x.translate(40, 40); x.rotate(rot); x.strokeRect(-24, -24, 48, 48); x.restore(); }); }
    else if (id === 'plus') { x.lineWidth = 6; x.beginPath(); x.moveTo(40, 28); x.lineTo(40, 52); x.moveTo(28, 40); x.lineTo(52, 40); x.stroke(); }
    return c;
  }
  const TEXTURES = [{ id: 'paper', label: 'Paper' }, { id: 'linen', label: 'Linen' }, { id: 'noise', label: 'Grain' }, { id: 'concrete', label: 'Concrete' }, { id: 'kraft', label: 'Kraft' }, { id: 'dark', label: 'Dark slate' }];
  function textureCanvas(id) {
    const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S; const x = c.getContext('2d');
    const base = { paper: [248, 244, 232], linen: [236, 228, 210], noise: [220, 220, 220], concrete: [168, 170, 172], kraft: [196, 160, 118], dark: [38, 46, 52] }[id] || [230, 230, 230];
    x.fillStyle = `rgb(${base})`; x.fillRect(0, 0, S, S);
    const img = x.getImageData(0, 0, S, S), d = img.data, r = rand(id.length * 977 + 13), amp = id === 'concrete' ? 38 : id === 'noise' ? 30 : 16;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * amp; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    x.putImageData(img, 0, 0);
    if (id === 'linen') { x.globalAlpha = 0.12; x.fillStyle = '#000'; for (let i = 0; i < S; i += 3) { x.fillRect(i, 0, 1, S); x.fillRect(0, i, S, 1); } x.globalAlpha = 1; }
    return c;
  }
  // Generated "library" backgrounds (drawn procedurally — no external images or licences involved).
  const LIB_BGS = [
    { id: 'sunburst', label: 'Sunburst' }, { id: 'bokeh', label: 'Bokeh' }, { id: 'mesh1', label: 'Aurora' }, { id: 'mesh2', label: 'Sunset mesh' },
    { id: 'waves', label: 'Layered waves' }, { id: 'confetti', label: 'Confetti' }, { id: 'rays', label: 'Spotlight' }, { id: 'diamonds', label: 'Diamonds' },
    { id: 'halftone', label: 'Halftone' }, { id: 'festival', label: 'Festival bunting' }, { id: 'islamicbg', label: 'Islamic night' }, { id: 'floral', label: 'Floral' }
  ];
  function libBgCanvas(id, W, H) {
    const S = Math.min(1400 / Math.max(W, H), 1), w = Math.round(W * S), h = Math.round(H * S);
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'), r = rand(id.length * 31 + 5), m = Math.max(w, h);
    const lin = (c1, c2, ang) => { const g = x.createLinearGradient(0, 0, w * Math.sin(ang), h * Math.cos(ang)); g.addColorStop(0, c1); g.addColorStop(1, c2); return g; };
    const blob = (cx, cy, rad, col) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); };
    if (id === 'sunburst') { x.fillStyle = '#F59E0B'; x.fillRect(0, 0, w, h); x.fillStyle = '#FBBF24'; for (let i = 0; i < 28; i += 2) { x.beginPath(); x.moveTo(w / 2, h / 2); x.arc(w / 2, h / 2, m, i / 28 * 6.2832, (i + 1) / 28 * 6.2832); x.fill(); } }
    else if (id === 'bokeh') { x.fillStyle = lin('#1E1B4B', '#7C3AED', 0.6); x.fillRect(0, 0, w, h); for (let i = 0; i < 40; i++) { x.fillStyle = `hsla(${280 + r() * 80},90%,70%,${0.1 + r() * 0.25})`; x.beginPath(); x.arc(r() * w, r() * h, m * (0.02 + r() * 0.07), 0, 7); x.fill(); } }
    else if (id === 'mesh1') { x.fillStyle = '#0B1B2B'; x.fillRect(0, 0, w, h); blob(w * .2, h * .2, m * .7, 'rgba(20,184,166,.85)'); blob(w * .85, h * .3, m * .6, 'rgba(99,102,241,.8)'); blob(w * .5, h * .95, m * .7, 'rgba(236,72,153,.7)'); }
    else if (id === 'mesh2') { x.fillStyle = '#FFEDD5'; x.fillRect(0, 0, w, h); blob(w * .15, h * .15, m * .7, 'rgba(251,146,60,.9)'); blob(w * .9, h * .5, m * .6, 'rgba(244,63,94,.75)'); blob(w * .4, h * .95, m * .6, 'rgba(250,204,21,.8)'); }
    else if (id === 'waves') { x.fillStyle = '#0E6E5D'; x.fillRect(0, 0, w, h); ['#14B8A6', '#5EEAD4', '#CCFBF1'].forEach((col, k) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, h); for (let i = 0; i <= 20; i++) x.lineTo(w * i / 20, h * (0.55 + k * 0.13) + Math.sin(i * 0.9 + k) * h * 0.04); x.lineTo(w, h); x.fill(); }); }
    else if (id === 'confetti') { x.fillStyle = '#FFF7ED'; x.fillRect(0, 0, w, h); for (let i = 0; i < 120; i++) { x.fillStyle = PALETTE[Math.floor(r() * PALETTE.length)]; x.save(); x.translate(r() * w, r() * h); x.rotate(r() * 6); x.fillRect(0, 0, m * 0.012, m * 0.025); x.restore(); } }
    else if (id === 'rays') { x.fillStyle = '#0F172A'; x.fillRect(0, 0, w, h); x.fillStyle = 'rgba(250,204,21,.16)'; for (let i = -4; i < 5; i++) { x.beginPath(); x.moveTo(w / 2, -10); x.lineTo(w / 2 + i * w * .22 - w * .06, h); x.lineTo(w / 2 + i * w * .22 + w * .06, h); x.fill(); } }
    else if (id === 'diamonds') { x.fillStyle = '#152420'; x.fillRect(0, 0, w, h); const s = m / 12; x.strokeStyle = 'rgba(204,154,60,.5)'; x.lineWidth = 2; for (let i = -1; i < w / s + 1; i++) for (let j = -1; j < h / s + 1; j++) { x.save(); x.translate(i * s + (j % 2) * s / 2, j * s / 2); x.rotate(Math.PI / 4); x.strokeRect(-s / 4, -s / 4, s / 2, s / 2); x.restore(); } }
    else if (id === 'halftone') { x.fillStyle = '#FEF3C7'; x.fillRect(0, 0, w, h); x.fillStyle = '#F97316'; const s = m / 28; for (let i = 0; i < w / s + 1; i++) for (let j = 0; j < h / s + 1; j++) { const rr = s * 0.48 * (j / (h / s + 1)); x.beginPath(); x.arc(i * s, j * s, rr, 0, 7); x.fill(); } }
    else if (id === 'festival') { x.fillStyle = lin('#FFF7ED', '#FED7AA', 0); x.fillRect(0, 0, w, h); x.strokeStyle = '#7C2D12'; x.lineWidth = 3; x.beginPath(); x.moveTo(0, h * .05); x.quadraticCurveTo(w / 2, h * .2, w, h * .05); x.stroke(); for (let i = 0; i < 9; i++) { const t = (i + 0.5) / 9, px = w * t, py = h * .05 + (1 - Math.pow(2 * t - 1, 2)) * h * .075; x.fillStyle = PALETTE[i % PALETTE.length]; x.beginPath(); x.moveTo(px - m * .025, py); x.lineTo(px + m * .025, py); x.lineTo(px, py + m * .06); x.fill(); } }
    else if (id === 'islamicbg') { x.fillStyle = lin('#0B2B26', '#134E4A', 0); x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(204,154,60,.35)'; x.lineWidth = 2; const s = m / 9; for (let i = 0; i <= w / s; i++) for (let j = 0; j <= h / s; j++) { x.save(); x.translate(i * s + s / 2, j * s + s / 2); [0, Math.PI / 4].forEach(a => { x.rotate(a); x.strokeRect(-s * .3, -s * .3, s * .6, s * .6); }); x.restore(); } x.fillStyle = '#FDE68A'; x.beginPath(); x.arc(w * .78, h * .14, m * .05, 0, 7); x.fill(); x.fillStyle = '#134E4A'; x.beginPath(); x.arc(w * .8, h * .13, m * .045, 0, 7); x.fill(); }
    else if (id === 'floral') { x.fillStyle = '#FFF1F2'; x.fillRect(0, 0, w, h); for (let i = 0; i < 26; i++) { const cx = r() * w, cy = r() * h, pr = m * (0.02 + r() * 0.03); x.fillStyle = `hsla(${330 + r() * 40},80%,75%,.55)`; for (let k = 0; k < 6; k++) { x.beginPath(); x.arc(cx + Math.cos(k * 1.047) * pr, cy + Math.sin(k * 1.047) * pr, pr * .8, 0, 7); x.fill(); } x.fillStyle = '#FBBF24'; x.beginPath(); x.arc(cx, cy, pr * .5, 0, 7); x.fill(); } }
    return c;
  }

  let bg = { type: 'solid', c1: '#ffffff', c2: '#0E6E5D', angle: 135, alpha: 1, id: null };
  function applyBg() {
    const c = cv(), { w, h } = A().size();
    c.backgroundImage = null; // image backgrounds are applied separately below
    if (bg.type === 'none') c.backgroundColor = '';
    else if (bg.type === 'solid') c.backgroundColor = bg.alpha < 1 ? rgba(bg.c1, bg.alpha) : bg.c1;
    else if (bg.type === 'gradient') c.backgroundColor = makeGradient(bg.c1, bg.c2, bg.angle, w, h, bg.alpha);
    else if (bg.type === 'pattern') c.backgroundColor = new fabric.Pattern({ source: tile(bg.id, bg.c1, bg.c2, bg.alpha), repeat: 'repeat' });
    else if (bg.type === 'texture') { c.backgroundColor = new fabric.Pattern({ source: textureCanvas(bg.id), repeat: 'repeat' }); }
    c.requestRenderAll(); A().commit();
  }
  function setBgSolid(color) { bg.type = 'solid'; bg.c1 = color; applyBg(); }
  function setBgNone() { bg.type = 'none'; applyBg(); }
  function setBgGradient(c1, c2, angle) { bg = Object.assign(bg, { type: 'gradient', c1: c1 || bg.c1, c2: c2 || bg.c2, angle: angle == null ? bg.angle : angle }); applyBg(); }
  function setBgPattern(id) { bg.type = 'pattern'; bg.id = id; applyBg(); }
  function setBgTexture(id) { bg.type = 'texture'; bg.id = id; applyBg(); }
  function setBgAlpha(a) {
    bg.alpha = a; const c = cv();
    if (c.backgroundImage) { c.backgroundImage.opacity = a; c.requestRenderAll(); A().commit(); } else applyBg();
  }
  function setBgImageCanvas(canvasEl, mode) {
    const c = cv(), { w, h } = A().size(), url = canvasEl.toDataURL('image/jpeg', 0.88);
    fabric.Image.fromURL(url, img => {
      const sx = w / img.width, sy = h / img.height, s = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
      img.set({ scaleX: s, scaleY: s, originX: 'center', originY: 'center', left: w / 2, top: h / 2, opacity: bg.alpha });
      c.backgroundImage = img; c.requestRenderAll(); A().commit();
    });
  }
  function setBgLibrary(id) { const { w, h } = A().size(); setBgImageCanvas(libBgCanvas(id, w, h), 'cover'); }
  function setBgUpload(e) {
    const f = e.target.files[0]; if (!f) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(f.type)) { toast('Use PNG, JPG or WebP', true); return; }
    const rd = new FileReader();
    rd.onload = ev => {
      const im = new Image(); im.onload = () => {
        const cnv = document.createElement('canvas'), k = Math.min(1, 2000 / Math.max(im.width, im.height)); cnv.width = im.width * k; cnv.height = im.height * k;
        cnv.getContext('2d').drawImage(im, 0, 0, cnv.width, cnv.height); setBgImageCanvas(cnv, 'cover');
      }; im.src = ev.target.result;
    };
    rd.readAsDataURL(f); e.target.value = '';
  }
  function clearBgImage() { cv().backgroundImage = null; cv().requestRenderAll(); A().commit(); }
  function initBackgrounds() { /* hook for future use */ }

  // makeFill: used by template builders ({bg: '#fff' | {type:'gradient',c1,c2,angle} | {type:'pattern',id,c1,c2} | null})
  function makeFill(spec, W, H) {
    if (!spec) return '';
    if (typeof spec === 'string') return spec;
    if (spec.type === 'gradient') return makeGradient(spec.c1, spec.c2, spec.angle, W, H);
    if (spec.type === 'pattern') return new fabric.Pattern({ source: tile(spec.id, spec.c1, spec.c2, spec.alpha == null ? 1 : spec.alpha), repeat: 'repeat' });
    return spec.c1 || '#ffffff';
  }

  // ------------------------------------------------------------------ drawer UI
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : s);
  const svgThumb = def => `<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="${def.d}" fill="#0E6E5D" fill-rule="${def.rule || 'nonzero'}"/></svg>`;
  let elemSub = 'Shapes', shapeCat = 'All', stickerCat = 'Festival';

  function renderElements(body) {
    const subs = ['Shapes', 'Lines', 'Frames', 'Stickers', 'Icons', 'Decor'];
    const adminCount = (window.STATE && STATE.stickers ? STATE.stickers.length : 0);
    if (adminCount) subs.push('Admin');
    let h = `<div class="studio-subtabs">${subs.map(s => `<button class="${s === elemSub ? 'active' : ''}" onclick="StudioLib.setSub('${s}')">${s}</button>`).join('')}</div>`;
    if (elemSub === 'Shapes') {
      const cats = ['All'].concat(Array.from(new Set(SHAPE_DATA.map(s => s.cat))));
      h += `<div class="studio-chiprow">${cats.map(c => `<button class="studio-chip ${c === shapeCat ? 'active' : ''}" onclick="StudioLib.setShapeCat('${c}')">${c}</button>`).join('')}</div><div class="studio-grid">`;
      h += `<button class="studio-cell" title="Square" onclick="StudioLib.addSquare()"><svg viewBox="0 0 100 100"><rect x="5" y="5" width="90" height="90" fill="#0E6E5D"/></svg></button>
            <button class="studio-cell" title="Rounded rectangle" onclick="StudioLib.addRoundedRect()"><svg viewBox="0 0 100 100"><rect x="5" y="15" width="90" height="70" rx="18" fill="#0E6E5D"/></svg></button>
            <button class="studio-cell" title="Circle" onclick="StudioLib.addCircle()"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#0E6E5D"/></svg></button>`;
      h += SHAPE_DATA.filter(s => shapeCat === 'All' || s.cat === shapeCat).map(s => `<button class="studio-cell" title="${esc(s.label)}" onclick="StudioLib.addShape('${s.id}')">${svgThumb(s)}</button>`).join('') + '</div>';
    } else if (elemSub === 'Lines') {
      h += `<div class="studio-list">${[['solid', 'Line'], ['dashed', 'Dashed line'], ['dotted', 'Dotted line'], ['thick', 'Thick bar'], ['arrow', 'Arrow'], ['double', 'Double arrow']].map(([k, l]) => `<button class="studio-listbtn" onclick="StudioLib.addLineStyle('${k}')">${l}</button>`).join('')}</div>`;
    } else if (elemSub === 'Frames') {
      h += `<div class="studio-hint">Page-sized borders and frames. To mask a photo inside a shape, select the photo and use <b>Edit → Photo frame</b>.</div><div class="studio-list">${[['thin', 'Thin border'], ['thick', 'Thick border'], ['double', 'Double border'], ['dashed', 'Dashed border'], ['rounded', 'Rounded border'], ['corners', 'Corner frame'], ['circle', 'Circle frame'], ['polaroid', 'Polaroid card']].map(([k, l]) => `<button class="studio-listbtn" onclick="StudioLib.addFrame('${k}')">${l}</button>`).join('')}</div>`;
    } else if (elemSub === 'Stickers') {
      h += `<div class="studio-chiprow">${Object.keys(STICKERS).map(c => `<button class="studio-chip ${c === stickerCat ? 'active' : ''}" onclick="StudioLib.setStickerCat('${c}')">${c}</button>`).join('')}</div><div class="studio-grid emoji">${STICKERS[stickerCat].map(e => `<button class="studio-cell" onclick="StudioLib.addEmoji('${e}')">${e}</button>`).join('')}</div>`;
    } else if (elemSub === 'Icons') {
      h += `<div class="studio-hint">Simple coloured contact / social badges (generic icons, not official brand logos).</div><div class="studio-grid">${SOCIAL.map(s => `<button class="studio-cell badge" title="${s.label}" onclick="StudioLib.addSocialBadge('${s.id}')"><span style="background:${s.bg}">${s.glyph}</span><small>${s.label}</small></button>`).join('')}</div>`;
    } else if (elemSub === 'Decor') {
      const items = [['confetti', 'Confetti'], ['dots', 'Dot grid'], ['sunburst', 'Sunburst rays'], ['wave', 'Wave footer'], ['corner', 'Corner ornament'], ['stripes', 'Stripe band'], ['islamicStar', 'Islamic 8-point star'], ['rosette', 'Geometric rosette'], ['mihrab', 'Islamic arch'], ['crescentStar', 'Crescent & star']];
      h += `<div class="studio-list">${items.map(([k, l]) => `<button class="studio-listbtn" onclick="StudioLib.addDecor('${k}')">${l}</button>`).join('')}</div>`;
    } else if (elemSub === 'Admin') {
      h += `<div class="studio-grid">${STATE.stickers.map(s => `<button class="studio-cell" onclick="StudioLib.addAdminSticker('${s.image_url}')"><img src="${s.image_url}" style="max-width:100%;max-height:100%" crossorigin="anonymous"></button>`).join('')}</div>`;
    }
    body.innerHTML = h;
  }
  function setSub(s) { elemSub = s; renderElements(document.getElementById('studioDrawerBody')); }
  function setShapeCat(c) { shapeCat = c; renderElements(document.getElementById('studioDrawerBody')); }
  function setStickerCat(c) { stickerCat = c; renderElements(document.getElementById('studioDrawerBody')); }

  function renderTextTab(body) {
    body.innerHTML = `<div class="studio-list">
      ${TEXT_STYLES.map((s, i) => `<button class="studio-textcard" onclick="StudioLib.addTextStyle(${i})"><span style="font-family:${s.fontFamily};font-size:22px;${s.gradient ? `background:linear-gradient(${s.gradient[0]},${s.gradient[1]});-webkit-background-clip:text;color:transparent;` : `color:${s.fill && s.fill.startsWith('rgba(0,0,0,0)') ? '#152420' : (s.fill || '#152420')};`}${s.stroke ? `-webkit-text-stroke:1px ${s.stroke};` : ''}${s.shadow && s.shadow.blur > 10 ? `text-shadow:0 0 8px ${s.shadow.color};` : ''}">${esc(s.text.trim().slice(0, 18))}</span><small>${esc(s.label)}</small></button>`).join('')}
    </div>
    <label class="studio-label">CURVED TEXT</label>
    <div class="studio-list">
      <button class="studio-listbtn" onclick="StudioLib.addCurvedText(60)">⌒ Arch up</button>
      <button class="studio-listbtn" onclick="StudioLib.addCurvedText(-60)">⌣ Arch down</button>
      <button class="studio-listbtn" onclick="StudioLib.addCurvedText(100)">◠ Half circle</button>
    </div>
    <div class="studio-hint">Malayalam, Hindi, Tamil and other Indian-script text work in all text styles. Use <b>Edit → Font</b> to pick a font for your language.</div>`;
  }

  function swatchHTML(colors, fn) { return colors.map(c => `<button class="studio-sw" style="background:${c}" onclick="${fn}('${c}')"></button>`).join(''); }
  const BG_COLORS = ['#FFFFFF', '#FBF6EA', '#F3ECDA', '#152420', '#111827', '#0E6E5D', '#CC9A3C', '#E1553B', '#DC2626', '#F59E0B', '#FACC15', '#22C55E', '#0EA5E9', '#2563EB', '#4F46E5', '#7C3AED', '#DB2777', '#F472B6', '#FEE2E2', '#DCFCE7', '#DBEAFE', '#FEF3C7'];
  function renderBackgroundTab(body) {
    body.innerHTML = `
      <label class="studio-label">SOLID COLOUR</label>
      <div class="studio-swatches">${swatchHTML(BG_COLORS, 'StudioLib.setBgSolid')}<input type="color" value="#ffffff" oninput="StudioLib.setBgSolid(this.value)" title="Custom colour"><button class="studio-sw trans" title="Transparent" onclick="StudioLib.setBgNone()"></button></div>
      <label class="studio-label">GRADIENT</label>
      <div class="studio-swatches">${GRADIENTS.map((g, i) => `<button class="studio-sw wide" style="background:linear-gradient(${g[2]}deg,${g[0]},${g[1]})" onclick="StudioLib.setBgGradient('${g[0]}','${g[1]}',${g[2]})"></button>`).join('')}</div>
      <div class="studio-prop-row"><label>Custom</label><input type="color" id="studioGradC1" value="#0E6E5D" onchange="StudioLib.customGradient()"><input type="color" id="studioGradC2" value="#CC9A3C" onchange="StudioLib.customGradient()"><input type="range" id="studioGradAng" min="0" max="360" value="135" onchange="StudioLib.customGradient()" title="Angle"></div>
      <label class="studio-label">PATTERN <small style="font-weight:500">(uses the two colours below)</small></label>
      <div class="studio-prop-row"><label>Colours</label><input type="color" id="studioPatC1" value="#FBF6EA"><input type="color" id="studioPatC2" value="#CC9A3C"></div>
      <div class="studio-swatches">${PATTERNS.map(p => `<button class="studio-chip" onclick="StudioLib.pickPattern('${p.id}')">${p.label}</button>`).join('')}</div>
      <label class="studio-label">TEXTURE</label>
      <div class="studio-swatches">${TEXTURES.map(t => `<button class="studio-chip" onclick="StudioLib.setBgTexture('${t.id}')">${t.label}</button>`).join('')}</div>
      <label class="studio-label">BACKGROUND LIBRARY</label>
      <div class="studio-grid bgs">${LIB_BGS.map(b => `<button class="studio-cell bg" onclick="StudioLib.setBgLibrary('${b.id}')"><canvas data-bg="${b.id}" width="90" height="90"></canvas><small>${b.label}</small></button>`).join('')}</div>
      <label class="studio-label">YOUR OWN IMAGE</label>
      <div class="studio-list"><button class="studio-listbtn" onclick="document.getElementById('studioBgUpload').click()">⬆ Upload background</button><button class="studio-listbtn" onclick="StudioLib.clearBgImage()">✕ Remove background image</button></div>
      <input type="file" id="studioBgUpload" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="StudioLib.setBgUpload(event)">
      <label class="studio-label">BACKGROUND TRANSPARENCY</label>
      <div class="studio-prop-row"><input type="range" min="0" max="1" step="0.05" value="1" oninput="StudioLib.setBgAlphaLive(this.value)" onchange="StudioLib.setBgAlpha(parseFloat(this.value))"></div>`;
    // paint library thumbnails
    body.querySelectorAll('canvas[data-bg]').forEach(cn => { const big = libBgCanvas(cn.dataset.bg, 300, 300); cn.getContext('2d').drawImage(big, 0, 0, 90, 90); });
  }
  function customGradient() {
    const v = id => document.getElementById(id).value; setBgGradient(v('studioGradC1'), v('studioGradC2'), parseInt(v('studioGradAng')));
  }
  function pickPattern(id) {
    bg.c1 = document.getElementById('studioPatC1').value; bg.c2 = document.getElementById('studioPatC2').value; setBgPattern(id);
  }
  function setBgAlphaLive(v) { bg.alpha = parseFloat(v); const c = cv(); if (c.backgroundImage) { c.backgroundImage.opacity = bg.alpha; c.requestRenderAll(); } }

  Studio.registerTab({ id: 'elements', label: 'Elements', icon: '✦', order: 20, render: renderElements });
  Studio.registerTab({ id: 'text', label: 'Text', icon: 'T', order: 30, render: renderTextTab });
  Studio.registerTab({ id: 'background', label: 'Background', icon: '▦', order: 40, render: renderBackgroundTab });

  return {
    SHAPE_DATA, TEXT_STYLES, fontList, allFontCss, rgba, toHex, rgbaToHex, hexToRgb, makeFill, makeGradient, makeShape, textGradient, buildCurvedGroup, updateCurved, rand, graphemes, tile, libBgCanvas, EMOJI_FONT, PALETTE,
    addShape, addSquare, addRoundedRect, addCircle, addLineStyle, addFrame, addEmoji, addSocialBadge, addAdminSticker, addDecor, addTextStyle, addCurvedText,
    setBgSolid, setBgNone, setBgGradient, setBgPattern, setBgTexture, setBgAlpha, setBgAlphaLive, setBgLibrary, setBgUpload, clearBgImage, customGradient, pickPattern, initBackgrounds,
    setSub, setShapeCat, setStickerCat
  };
})();


// ======================= studio-fx.js =======================
// ===================================================================================
// DESIGN STUDIO — properties panel ("Edit" tab): position/size, text styling & effects,
// shape fill/stroke/gradient, curved text, photo editing (filters, crop, borders, frames,
// shadows, manual background removal) for whatever is selected on the canvas.
// ===================================================================================
var StudioFx = (() => {
  const A = () => Studio.api, cv = () => A().canvas();
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s));
  const openSecs = new Set(['pos', 'main']);
  const hex = v => StudioLib.toHex(v);
  function sec(id, title, inner) {
    return `<details class="studio-sec" ${openSecs.has(id) ? 'open' : ''} ontoggle="StudioFx.secToggle('${id}',this.open)"><summary>${title}</summary><div class="studio-sec-body">${inner}</div></details>`;
  }
  function secToggle(id, open) { open ? openSecs.add(id) : openSecs.delete(id); }
  const row = (label, input) => `<div class="studio-prop-row"><label>${label}</label>${input}</div>`;
  const rng = (min, max, step, val, key, extra) => `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}" oninput="StudioFx.live('${key}',parseFloat(this.value))" onchange="StudioFx.commitProp('${key}',parseFloat(this.value))" ${extra || ''}>`;
  const col = (val, key) => `<input type="color" value="${hex(val)}" oninput="StudioFx.live('${key}',this.value)" onchange="StudioFx.commitProp('${key}',this.value)">`;
  const btn = (label, fn, active, title) => `<button class="btn btn-outline btn-sm ${active ? 'on' : ''}" ${title ? `title="${title}"` : ''} onclick="${fn}">${label}</button>`;

  function isText(o) { return o && (o.type === 'i-text' || o.type === 'text' || o.type === 'textbox'); }
  function isImage(o) { return o && o.type === 'image'; }
  function isCurved(o) { return o && o.studioCurve; }
  function isMulti(o) { return o && o.type === 'group' && !o.studioCurve; }
  function isShape(o) { return o && ['rect', 'ellipse', 'circle', 'triangle', 'path', 'polygon', 'line'].includes(o.type); }

  // ------------------------------------------------------------------ main render
  function render(obj, body, soft) {
    if (!obj) { body.innerHTML = '<p class="studio-empty-hint">Tap an object on the canvas to edit it. Use the <b>Library</b> button to add shapes, text, photos, backgrounds and templates.</p>'; return; }
    if (obj.type === 'activeSelection') { body.innerHTML = selectionHTML(obj); return; }
    let h = '';
    if (isText(obj)) h += textHTML(obj);
    else if (isCurved(obj)) h += curvedHTML(obj);
    else if (isImage(obj)) h += imageHTML(obj);
    else if (isMulti(obj)) h += multiHTML(obj);
    else if (isShape(obj)) h += shapeHTML(obj);
    h += positionHTML(obj) + shadowHTML(obj);
    h += `<div class="studio-actions">${btn('📄 Duplicate', 'Studio.duplicateSelection()')}${btn('🔒 Lock', 'Studio.toggleLockSelection()')}${btn('🗑 Delete', 'Studio.deleteSelection()')}</div>`;
    // Don't rebuild the panel while the user is typing in a text box inside it (keeps cursor/focus).
    const ae = document.activeElement;
    if (ae && body.contains(ae) && ae.tagName === 'TEXTAREA') return;
    body.innerHTML = h;
  }

  // ------------------------------------------------------------------ position / size / order
  function positionHTML(o) {
    o.setCoords(); const b = o.getBoundingRect(true, true), R = Math.round;
    const n = (k, v) => `<input type="number" value="${R(v)}" onchange="Studio.setPosition('${k}',parseFloat(this.value))">`;
    return sec('pos', 'Position, size &amp; order',
      row('X', n('x', b.left)) + row('Y', n('y', b.top)) + row('Width', n('w', b.width)) + row('Height', n('h', b.height)) +
      row('Rotate', `<input type="number" value="${R(o.angle || 0)}" onchange="Studio.setProp('angle',parseFloat(this.value))">`) +
      row('Opacity', rng(0, 1, 0.05, o.opacity == null ? 1 : o.opacity, 'opacity')) +
      `<div class="studio-actions">${btn('⇋ Flip H', "Studio.flip('x')")}${btn('⇅ Flip V', "Studio.flip('y')")}</div>
       <div class="studio-actions">${btn('⤒ Front', 'Studio.bringToFront()')}${btn('↑ Forward', 'Studio.bringForwardSel()')}${btn('↓ Back', 'Studio.sendBackwardSel()')}${btn('⤓ Bottom', 'Studio.sendToBack()')}</div>
       <div class="studio-actions">${['left', 'centerH', 'right', 'top', 'centerV', 'bottom'].map((m, i) => btn(['⇤', '↔', '⇥', '⤒', '↕', '⤓'][i], `Studio.align('${m}')`, false, 'Align to page: ' + m)).join('')}</div>`);
  }

  // ------------------------------------------------------------------ shadow (all objects)
  function shadowHTML(o) {
    const s = o.shadow, on = !!s;
    return sec('shadow', 'Shadow',
      row('Enable', `<input type="checkbox" ${on ? 'checked' : ''} onchange="StudioFx.shadow()" id="fxShOn">`) +
      row('Colour', `<input type="color" id="fxShC" value="${on ? (StudioLib.rgbaToHex(s.color) || hex(s.color)) : '#000000'}" onchange="StudioFx.shadow()">`) +
      row('Blur', `<input type="range" id="fxShB" min="0" max="60" value="${on ? s.blur : 12}" onchange="StudioFx.shadow()">`) +
      row('Offset X', `<input type="range" id="fxShX" min="-40" max="40" value="${on ? s.offsetX : 6}" onchange="StudioFx.shadow()">`) +
      row('Offset Y', `<input type="range" id="fxShY" min="-40" max="40" value="${on ? s.offsetY : 8}" onchange="StudioFx.shadow()">`) +
      row('Strength', `<input type="range" id="fxShA" min="0.05" max="1" step="0.05" value="${on ? (shadowAlpha(s.color)) : 0.35}" onchange="StudioFx.shadow()">`));
  }
  function shadowAlpha(c) { const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(c || ''); return m ? parseFloat(m[1]) : 1; }
  function shadow() {
    const o = cv().getActiveObject(); if (!o) return; const g = id => document.getElementById(id);
    if (!g('fxShOn').checked) { o.set('shadow', null); }
    else o.set('shadow', new fabric.Shadow({ color: StudioLib.rgba(g('fxShC').value, parseFloat(g('fxShA').value)), blur: +g('fxShB').value, offsetX: +g('fxShX').value, offsetY: +g('fxShY').value }));
    o.dirty = true; cv().requestRenderAll(); A().commit();
  }

  // ------------------------------------------------------------------ text
  function textHTML(o) {
    const fonts = StudioLib.fontList();
    const grad = o.fill && o.fill.type === 'linear', g0 = grad ? o.fill.colorStops[0].color : '#F7E08A', g1 = grad ? o.fill.colorStops[o.fill.colorStops.length - 1].color : '#B8860B';
    const bgc = o.textBackgroundColor;
    return sec('main', 'Text',
      row('Text', `<textarea oninput="StudioFx.textValue(this.value)" onchange="Studio.api.commit()">${esc(o.text)}</textarea>`) +
      row('Font', `<select onchange="StudioFx.setFont(parseInt(this.value))">${fonts.map((f, i) => `<option value="${i}" style="font-family:${f.css}" ${o.fontFamily === f.css ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>`) +
      row('Size', `<input type="number" min="6" max="600" value="${Math.round((o.fontSize || 40) * (o.scaleY || 1))}" onchange="StudioFx.setFontSize(parseFloat(this.value))">`) +
      row('Colour', col(grad ? g0 : o.fill, 'fill')) +
      `<div class="studio-actions">${btn('<b>B</b>', `Studio.setProp('fontWeight','${o.fontWeight === 'bold' || o.fontWeight === '700' || o.fontWeight === '800' || o.fontWeight === '900' ? 'normal' : 'bold'}')`, ['bold', '700', '800', '900'].includes(String(o.fontWeight)))}
        ${btn('<i>I</i>', `Studio.setProp('fontStyle','${o.fontStyle === 'italic' ? 'normal' : 'italic'}')`, o.fontStyle === 'italic')}
        ${btn('<u>U</u>', `Studio.setProp('underline',${!o.underline})`, o.underline)}
        ${btn('<s>S</s>', `Studio.setProp('linethrough',${!o.linethrough})`, o.linethrough)}
        ${btn('⇤', "Studio.setProp('textAlign','left')", o.textAlign === 'left')}${btn('↔', "Studio.setProp('textAlign','center')", o.textAlign === 'center')}${btn('⇥', "Studio.setProp('textAlign','right')", o.textAlign === 'right')}</div>` +
      row('Letter sp.', rng(-100, 1000, 10, o.charSpacing || 0, 'charSpacing')) +
      row('Line sp.', rng(0.6, 2.6, 0.05, o.lineHeight || 1.16, 'lineHeight'))) +
      sec('textfx', 'Text effects',
        row('Gradient', `<input type="checkbox" ${grad ? 'checked' : ''} onchange="StudioFx.textGradient(this.checked)" id="fxGradOn"><input type="color" id="fxG0" value="${hex(g0)}" onchange="StudioFx.textGradient(document.getElementById('fxGradOn').checked)"><input type="color" id="fxG1" value="${hex(g1)}" onchange="StudioFx.textGradient(document.getElementById('fxGradOn').checked)">`) +
        row('Outline', `<input type="color" value="${hex(o.stroke || '#000000')}" onchange="StudioFx.commitProp('stroke',this.value);Studio.setProp('paintFirst','stroke')">`) +
        row('Outline w.', rng(0, 30, 1, o.strokeWidth || 0, 'strokeWidth')) +
        row('Highlight', `<input type="color" value="${hex(bgc || '#FACC15')}" onchange="StudioFx.commitProp('textBackgroundColor',this.value)">${btn('✕', "StudioFx.commitProp('textBackgroundColor','')", false, 'Remove highlight')}`)) +
      sec('curve', 'Curve this text', `<div class="studio-actions">${btn('⌒ Arch up', 'StudioFx.toCurved(60)')}${btn('⌣ Arch down', 'StudioFx.toCurved(-60)')}</div><div class="studio-hint">Converts to curved text (best with Latin letters; complex Indian scripts may not shape correctly when curved).</div>`);
  }
  function textValue(v) { const o = cv().getActiveObject(); if (!o) return; o.set('text', v); o.dirty = true; cv().requestRenderAll(); }
  async function setFont(i) {
    const f = StudioLib.fontList()[i], o = cv().getActiveObject(); if (!f || !o) return;
    await A().ensureFonts([f.css], o.text);
    if (isCurved(o)) { StudioLib.updateCurved(o, { fontFamily: f.css }); A().commit(); return; }
    o.set('fontFamily', f.css); o.initDimensions && o.initDimensions(); o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  function setFontSize(v) {
    const o = cv().getActiveObject(); if (!o || !(v > 0)) return;
    if (isCurved(o)) { StudioLib.updateCurved(o, { fontSize: v }); A().commit(); return; }
    o.set({ fontSize: v / (o.scaleY || 1) }); o.setCoords(); o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  function textGradient(on) {
    const o = cv().getActiveObject(); if (!o) return; const g = id => document.getElementById(id).value;
    o.set('fill', on ? StudioLib.textGradient(g('fxG0'), g('fxG1')) : g('fxG0')); o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  async function toCurved(curve) {
    const o = cv().getActiveObject(); if (!isText(o)) return; const c = cv();
    const spec = { text: o.text, curve, fontSize: Math.round(o.fontSize * (o.scaleY || 1)), fontFamily: o.fontFamily, fontWeight: o.fontWeight || 'normal', fill: typeof o.fill === 'string' ? o.fill : '#152420', spacing: Math.round((o.charSpacing || 0) / 1000 * o.fontSize), stroke: o.stroke, strokeWidth: o.strokeWidth };
    await A().ensureFonts([spec.fontFamily], spec.text);
    const g = StudioLib.buildCurvedGroup(spec), ctr = o.getCenterPoint(), idx = c.getObjects().indexOf(o);
    g.set({ originX: 'center', originY: 'center', left: ctr.x, top: ctr.y, angle: o.angle || 0, shadow: o.shadow, opacity: o.opacity });
    c.remove(o); c.insertAt(g, idx, false); c.setActiveObject(g); c.requestRenderAll(); A().commit();
  }
  function curvedHTML(o) {
    const s = o.studioCurve, fonts = StudioLib.fontList();
    return sec('main', 'Curved text',
      row('Text', `<textarea oninput="StudioFx.curvedLive({text:this.value},false)" onchange="StudioFx.curvedLive({text:this.value},true)">${esc(s.text)}</textarea>`) +
      row('Curve', `<input type="range" min="-100" max="100" step="1" value="${s.curve}" oninput="StudioFx.curvedLive({curve:parseFloat(this.value)},false)" onchange="StudioFx.curvedLive({curve:parseFloat(this.value)},true)">`) +
      row('Font', `<select onchange="StudioFx.setFont(parseInt(this.value))">${fonts.map((f, i) => `<option value="${i}" style="font-family:${f.css}" ${s.fontFamily === f.css ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>`) +
      row('Size', `<input type="number" value="${s.fontSize}" onchange="StudioFx.setFontSize(parseFloat(this.value))">`) +
      row('Colour', `<input type="color" value="${hex(s.fill)}" oninput="StudioFx.curvedLive({fill:this.value},false)" onchange="StudioFx.curvedLive({fill:this.value},true)">`) +
      row('Spacing', `<input type="range" min="-10" max="60" value="${s.spacing || 0}" oninput="StudioFx.curvedLive({spacing:parseFloat(this.value)},false)" onchange="StudioFx.curvedLive({spacing:parseFloat(this.value)},true)">`) +
      row('Outline', `<input type="color" value="${hex(s.stroke || '#000000')}" onchange="StudioFx.curvedLive({stroke:this.value,strokeWidth:Math.max(2,${s.strokeWidth || 0})},true)">`) +
      row('Outline w.', `<input type="range" min="0" max="20" value="${s.strokeWidth || 0}" onchange="StudioFx.curvedLive({strokeWidth:parseFloat(this.value)},true)">`));
  }
  function curvedLive(patch, commit) {
    const o = cv().getActiveObject(); if (!isCurved(o)) return;
    const g = StudioLib.updateCurved(o, patch); if (commit) A().commit();
    return g;
  }

  // ------------------------------------------------------------------ shapes / groups
  function shapeHTML(o) {
    const isLine = o.type === 'line', hasFill = !isLine, grad = o.fill && o.fill.type === 'linear';
    const g0 = grad ? o.fill.colorStops[0].color : '#0E6E5D', g1 = grad ? o.fill.colorStops[o.fill.colorStops.length - 1].color : '#CC9A3C';
    let h = '';
    if (hasFill) h += row('Fill', `<input type="color" value="${hex(grad ? g0 : o.fill)}" oninput="StudioFx.live('fill',this.value)" onchange="StudioFx.commitProp('fill',this.value)">${btn('∅', "StudioFx.commitProp('fill','rgba(0,0,0,0)')", false, 'No fill')}`);
    if (hasFill) h += row('Gradient', `<input type="checkbox" ${grad ? 'checked' : ''} id="fxSGOn" onchange="StudioFx.shapeGradient()"><input type="color" id="fxSG0" value="${hex(g0)}" onchange="StudioFx.shapeGradient()"><input type="color" id="fxSG1" value="${hex(g1)}" onchange="StudioFx.shapeGradient()"><input type="range" id="fxSGA" min="0" max="360" value="${o.studioGradAngle || 135}" onchange="StudioFx.shapeGradient()">`);
    h += row('Outline', `<input type="color" value="${hex(o.stroke || '#152420')}" oninput="StudioFx.live('stroke',this.value)" onchange="StudioFx.commitProp('stroke',this.value)">`);
    h += row('Outline w.', rng(0, 60, 1, o.strokeWidth || 0, 'strokeWidth'));
    h += row('Dash', `<select onchange="StudioFx.dash(this.value)"><option value="solid">Solid</option><option value="dash" ${o.strokeDashArray && o.strokeDashArray[0] > 6 ? 'selected' : ''}>Dashed</option><option value="dot" ${o.strokeDashArray && o.strokeDashArray[0] <= 6 ? 'selected' : ''}>Dotted</option></select>`);
    if (o.type === 'rect') h += row('Corners', `<input type="range" min="0" max="${Math.round(Math.min(o.width, o.height) / 2)}" value="${o.rx || 0}" oninput="StudioFx.corners(this.value,false)" onchange="StudioFx.corners(this.value,true)">`);
    return sec('main', 'Shape', h);
  }
  function corners(v, commit) { const o = cv().getActiveObject(); if (!o) return; o.set({ rx: +v, ry: +v }); o.dirty = true; cv().requestRenderAll(); if (commit) A().commit(); }
  function dash(kind) {
    const o = cv().getActiveObject(); if (!o) return; const w = Math.max(2, o.strokeWidth || 4);
    o.set('strokeDashArray', kind === 'dash' ? [w * 3, w * 2] : kind === 'dot' ? [1, w * 2] : null);
    if (kind === 'dot') o.set('strokeLineCap', 'round'); o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  function shapeGradient() {
    const o = cv().getActiveObject(); if (!o) return; const g = id => document.getElementById(id);
    if (!g('fxSGOn').checked) { o.set('fill', g('fxSG0').value); }
    else {
      const th = (+g('fxSGA').value) * Math.PI / 180, vx = Math.sin(th), vy = -Math.cos(th);
      o.set('fill', new fabric.Gradient({ type: 'linear', gradientUnits: 'percentage', coords: { x1: 0.5 - vx / 2, y1: 0.5 - vy / 2, x2: 0.5 + vx / 2, y2: 0.5 + vy / 2 }, colorStops: [{ offset: 0, color: g('fxSG0').value }, { offset: 1, color: g('fxSG1').value }] }));
      o.studioGradAngle = +g('fxSGA').value;
    }
    o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  function walk(o, fn) { fn(o); if (o._objects) o._objects.forEach(c => walk(c, fn)); }
  function multiHTML(o) {
    return sec('main', 'Group',
      row('Recolour', `<input type="color" value="#0E6E5D" onchange="StudioFx.recolorGroup(this.value,'fill')"><small>fills</small><input type="color" value="#152420" onchange="StudioFx.recolorGroup(this.value,'stroke')"><small>lines</small>`) +
      `<div class="studio-actions">${btn('Ungroup', 'Studio.ungroupSelection()')}</div>`);
  }
  function recolorGroup(color, which) {
    const o = cv().getActiveObject(); if (!o) return;
    walk(o, c => {
      if (c === o || c.type === 'group') return;
      if (which === 'fill' && c.fill && c.fill !== 'transparent' && c.fill !== 'rgba(0,0,0,0)' && typeof c.fill === 'string') c.set('fill', color);
      if (which === 'stroke' && c.stroke) c.set('stroke', color);
      c.dirty = true;
    });
    o.dirty = true; cv().requestRenderAll(); A().commit();
  }
  function selectionHTML(o) {
    const objs = o.getObjects();
    const alignBtns = [['left', '⇤', 'Align left edges'], ['centerH', '↔', 'Align centres horizontally'], ['right', '⇥', 'Align right edges'], ['top', '⤒', 'Align tops'], ['centerV', '↕', 'Align middles'], ['bottom', '⤓', 'Align bottoms'], ['distH', '⋯', 'Distribute horizontally'], ['distV', '⋮', 'Distribute vertically']];
    return sec('main', `${objs.length} objects selected`,
      `<div class="studio-hint">Align the selected objects to each other:</div><div class="studio-actions">${alignBtns.map(([m, l, t]) => btn(l, `Studio.alignEach('${m}')`, false, t)).join('')}</div>
       <div class="studio-actions">${btn('⛓️ Group', 'Studio.groupSelection()')}${btn('📄 Duplicate', 'Studio.duplicateSelection()')}${btn('🔒 Lock/Unlock', 'Studio.toggleLockSelection()')}${btn('🗑 Delete', 'Studio.deleteSelection()')}</div>
       <div class="studio-hint">Or align the whole selection to the page:</div><div class="studio-actions">${['left', 'centerH', 'right', 'top', 'centerV', 'bottom'].map((m, i) => btn(['⇤', '↔', '⇥', '⤒', '↕', '⤓'][i], `Studio.align('${m}')`)).join('')}</div>`);
  }

  // ------------------------------------------------------------------ generic property setters
  function live(key, val) { Studio.setPropLive(key, val); }
  function commitProp(key, val) { Studio.setProp(key, val); }

  // ------------------------------------------------------------------ images
  function fxOf(o) {
    if (!o.studioFx) o.studioFx = {};
    const f = o.studioFx; const orig = o.getOriginalSize ? o.getOriginalSize() : { width: o.width, height: o.height };
    f.origW = f.origW || orig.width; f.origH = f.origH || orig.height;
    f.brightness = f.brightness || 0; f.contrast = f.contrast || 0; f.saturation = f.saturation || 0; f.blur = f.blur || 0; f.hue = f.hue || 0;
    f.cl = f.cl || 0; f.cr = f.cr || 0; f.ct = f.ct || 0; f.cb = f.cb || 0; f.rmDist = f.rmDist == null ? 0.12 : f.rmDist; f.rmColor = f.rmColor || '#ffffff';
    return f;
  }
  const FILTER_PRESETS = [
    ['Original', { brightness: 0, contrast: 0, saturation: 0, hue: 0, gray: false, sepia: false, invert: false, sharpen: false, blur: 0 }],
    ['Vivid', { brightness: 0.03, contrast: 0.15, saturation: 0.45 }], ['Warm', { brightness: 0.05, contrast: 0.05, saturation: 0.15, hue: -0.04 }],
    ['Cool', { brightness: 0, contrast: 0.08, saturation: 0.05, hue: 0.06 }], ['B&W', { gray: true, contrast: 0.12 }], ['Vintage', { sepia: true, contrast: -0.05, brightness: 0.04 }],
    ['Fade', { brightness: 0.1, contrast: -0.2, saturation: -0.25 }], ['Dramatic', { contrast: 0.35, saturation: -0.1, brightness: -0.05 }], ['Invert', { invert: true }]
  ];
  function imageHTML(o) {
    const f = fxOf(o), fr = o.studioFrame || 'none';
    const sl = (label, key, min, max, step) => row(label, `<input type="range" min="${min}" max="${max}" step="${step}" value="${f[key] || 0}" oninput="StudioFx.fxLive('${key}',parseFloat(this.value))" onchange="StudioFx.fxCommit()">`);
    const chk = (label, key) => row(label, `<input type="checkbox" ${f[key] ? 'checked' : ''} onchange="StudioFx.fxSet('${key}',this.checked)">`);
    const frames = [['none', 'None'], ['circle', 'Circle'], ['rounded', 'Rounded'], ['squircle', 'Soft square'], ['heart', 'Heart'], ['star5', 'Star'], ['hexagon', 'Hexagon'], ['diamond', 'Diamond'], ['arch', 'Arch'], ['drop', 'Drop'], ['flower8', 'Flower'], ['burst12', 'Burst']];
    return sec('main', 'Photo',
      `<div class="studio-actions">${btn('⤢ Fill page', 'StudioFx.fitPage(true)')}${btn('⤡ Fit page', 'StudioFx.fitPage(false)')}${btn('◎ Center', "Studio.align('centerH');Studio.align('centerV')")}</div>
       <div class="studio-chiprow">${FILTER_PRESETS.map(([n], i) => `<button class="studio-chip" onclick="StudioFx.preset(${i})">${n}</button>`).join('')}</div>`) +
      sec('adjust', 'Adjust',
        sl('Brightness', 'brightness', -1, 1, 0.01) + sl('Contrast', 'contrast', -1, 1, 0.01) + sl('Saturation', 'saturation', -1, 1, 0.01) + sl('Hue', 'hue', -1, 1, 0.01) + sl('Blur', 'blur', 0, 1, 0.01) +
        chk('Greyscale', 'gray') + chk('Sepia', 'sepia') + chk('Invert', 'invert') + chk('Sharpen', 'sharpen')) +
      sec('crop', 'Crop (% trimmed from each side)',
        ['cl:Left', 'cr:Right', 'ct:Top', 'cb:Bottom'].map(s => { const [k, l] = s.split(':'); return row(l, `<input type="range" min="0" max="45" step="1" value="${f[k]}" oninput="StudioFx.cropLive('${k}',parseFloat(this.value))" onchange="StudioFx.cropCommit()">`); }).join('') +
        `<div class="studio-actions">${btn('Reset crop', 'StudioFx.cropReset()')}</div>`) +
      sec('frame', 'Photo frame (mask)', `<div class="studio-chiprow">${frames.map(([k, l]) => `<button class="studio-chip ${fr === k ? 'active' : ''}" onclick="StudioFx.setFrame('${k}')">${l}</button>`).join('')}</div>`) +
      sec('border', 'Border', row('Colour', `<input type="color" value="${hex(o.stroke || '#ffffff')}" onchange="StudioFx.commitProp('stroke',this.value)">`) + row('Width', rng(0, 40, 1, o.strokeWidth || 0, 'strokeWidth'))) +
      sec('rmbg', 'Remove background (manual)',
        `<div class="studio-hint">Works best on plain / single-colour backgrounds. Pick the background colour, then raise the tolerance until it disappears.</div>` +
        row('Colour', `<input type="color" id="fxRmC" value="${f.rmColor}" onchange="StudioFx.rmColor(this.value)">${btn('Pick corner', 'StudioFx.pickCorner()', false, 'Use the colour in the top-left corner of the photo')}`) +
        row('Tolerance', `<input type="range" min="0.01" max="0.6" step="0.01" value="${f.rmDist}" oninput="StudioFx.rmDistLive(parseFloat(this.value))" onchange="StudioFx.fxCommit()">`) +
        `<div class="studio-actions">${btn(f.rmOn ? 'Turn off' : 'Remove background', 'StudioFx.rmToggle()', f.rmOn)}</div>`);
  }
  function buildFilters(f) {
    const F = fabric.Image.filters, arr = [];
    if (f.rmOn) arr.push(new F.RemoveColor({ color: f.rmColor, distance: f.rmDist }));
    if (f.brightness) arr.push(new F.Brightness({ brightness: f.brightness }));
    if (f.contrast) arr.push(new F.Contrast({ contrast: f.contrast }));
    if (f.saturation) arr.push(new F.Saturation({ saturation: f.saturation }));
    if (f.hue) arr.push(new F.HueRotation({ rotation: f.hue }));
    if (f.gray) arr.push(new F.Grayscale());
    if (f.sepia) arr.push(new F.Sepia());
    if (f.invert) arr.push(new F.Invert());
    if (f.sharpen) arr.push(new F.Convolute({ matrix: [0, -1, 0, -1, 5, -1, 0, -1, 0] }));
    if (f.blur) arr.push(new F.Blur({ blur: f.blur }));
    return arr;
  }
  let fxTimer = null;
  function applyFx(o, immediate) {
    const run = () => { o.filters = buildFilters(o.studioFx); o.applyFilters(); cv().requestRenderAll(); };
    if (immediate) run(); else { clearTimeout(fxTimer); fxTimer = setTimeout(run, 60); } // light debounce while dragging sliders
  }
  function fxLive(key, v) { const o = cv().getActiveObject(); if (!isImage(o)) return; fxOf(o)[key] = v; applyFx(o); }
  function fxSet(key, v) { const o = cv().getActiveObject(); if (!isImage(o)) return; fxOf(o)[key] = v; applyFx(o, true); A().commit(); }
  function fxCommit() { setTimeout(() => A().commit(), 120); }
  function preset(i) {
    const o = cv().getActiveObject(); if (!isImage(o)) return; const f = fxOf(o);
    Object.assign(f, { brightness: 0, contrast: 0, saturation: 0, hue: 0, gray: false, sepia: false, invert: false, sharpen: false, blur: 0 }, FILTER_PRESETS[i][1]);
    applyFx(o, true); A().commit();
  }
  function rmColor(c) { const o = cv().getActiveObject(); if (!isImage(o)) return; fxOf(o).rmColor = c; if (o.studioFx.rmOn) applyFx(o, true); A().commit(); }
  function rmDistLive(v) { const o = cv().getActiveObject(); if (!isImage(o)) return; const f = fxOf(o); f.rmDist = v; f.rmOn = true; applyFx(o); }
  function rmToggle() { const o = cv().getActiveObject(); if (!isImage(o)) return; const f = fxOf(o); f.rmOn = !f.rmOn; applyFx(o, true); A().commit(); }
  function pickCorner() {
    const o = cv().getActiveObject(); if (!isImage(o)) return;
    try {
      const el = o.getElement(), c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d'); x.drawImage(el, 2, 2, 1, 1, 0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data, h = '#' + [d[0], d[1], d[2]].map(n => n.toString(16).padStart(2, '0')).join('');
      fxOf(o).rmColor = h; document.getElementById('fxRmC').value = h; if (o.studioFx.rmOn) applyFx(o, true); toast('Background colour picked');
    } catch (e) { toast('Could not read that image\'s pixels — pick the colour manually', true); }
  }
  // Crop through Fabric's cropX/cropY/width/height; keeps the visible part where it was.
  function cropApply(o, commit) {
    const f = fxOf(o), ow = f.origW, oh = f.origH;
    const nx = ow * f.cl / 100, ny = oh * f.ct / 100, nw = Math.max(8, ow * (1 - (f.cl + f.cr) / 100)), nh = Math.max(8, oh * (1 - (f.ct + f.cb) / 100));
    const ocx = (o.cropX || 0) + o.width / 2, ocy = (o.cropY || 0) + o.height / 2, ncx = nx + nw / 2, ncy = ny + nh / 2;
    const dx = (ncx - ocx) * o.scaleX * (o.flipX ? -1 : 1), dy = (ncy - ocy) * o.scaleY * (o.flipY ? -1 : 1), a = (o.angle || 0) * Math.PI / 180;
    const c = o.getCenterPoint();
    o.set({ cropX: nx, cropY: ny, width: nw, height: nh });
    o.setPositionByOrigin(new fabric.Point(c.x + dx * Math.cos(a) - dy * Math.sin(a), c.y + dx * Math.sin(a) + dy * Math.cos(a)), 'center', 'center');
    if (o.studioFrame && o.studioFrame !== 'none') applyFrame(o, o.studioFrame);
    o.setCoords(); o.dirty = true; cv().requestRenderAll(); if (commit) A().commit();
  }
  function cropLive(k, v) { const o = cv().getActiveObject(); if (!isImage(o)) return; const f = fxOf(o); f[k] = v; if (f.cl + f.cr > 90) return; cropApply(o, false); }
  function cropCommit() { A().commit(); }
  function cropReset() { const o = cv().getActiveObject(); if (!isImage(o)) return; Object.assign(fxOf(o), { cl: 0, cr: 0, ct: 0, cb: 0 }); cropApply(o, true); }
  function fitPage(cover) {
    const o = cv().getActiveObject(); if (!o) return; const { w, h } = A().size();
    const bw = o.width, bh = o.height, s = (cover ? Math.max : Math.min)(w / bw, h / bh);
    o.set({ scaleX: s, scaleY: s, angle: 0, originX: 'center', originY: 'center', left: w / 2, top: h / 2 }); o.setCoords(); cv().requestRenderAll(); A().commit();
  }
  function applyFrame(o, kind) {
    if (kind === 'none') { o.clipPath = null; return; }
    const w = o.width, h = o.height, m = Math.min(w, h); let clip;
    if (kind === 'circle') clip = new fabric.Ellipse({ rx: m / 2, ry: m / 2 });
    else if (kind === 'rounded') clip = new fabric.Rect({ width: w, height: h, rx: m * 0.12, ry: m * 0.12 });
    else if (kind === 'squircle') clip = new fabric.Rect({ width: w, height: h, rx: m * 0.3, ry: m * 0.3 });
    else { const p = StudioLib.makeShape(kind); const s = m / Math.max(p.width, p.height); p.set({ scaleX: s * (p.width >= p.height ? 1 : 1), scaleY: s }); clip = p; }
    clip.set({ originX: 'center', originY: 'center', left: 0, top: 0 });
    o.clipPath = clip;
  }
  function setFrame(kind) { const o = cv().getActiveObject(); if (!isImage(o)) return; o.studioFrame = kind; applyFrame(o, kind); o.dirty = true; cv().requestRenderAll(); A().commit(); }

  function onScaling() { /* reserved: live size read-out */ }

  return { render, secToggle, live, commitProp, shadow, textValue, setFont, setFontSize, textGradient, toCurved, curvedLive, corners, dash, shapeGradient, recolorGroup,
    fxLive, fxSet, fxCommit, preset, rmColor, rmDistLive, rmToggle, pickCorner, cropLive, cropCommit, cropReset, fitPage, setFrame, onScaling };
})();


// ======================= studio-tpl.js =======================
// ===================================================================================
// DESIGN STUDIO — template library.
// 29 categories x 2 layouts (+ Malayalam extras). Every template is built from real Fabric
// objects (text, shapes, emoji), so everything is fully editable once opened.
// Layouts are proportional: they adapt to the template's canvas size (square, portrait, story,
// landscape thumbnail, wide banner). Includes search, category filter, favourites,
// free/premium flags and live previews.
// ===================================================================================
var StudioTpl = (() => {
  const A = () => Studio.api, F = fabric;
  const EMOJI = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  const FONT = {
    anton: "'Anton',sans-serif", serif: "'Fraunces',serif", body: "'Manrope',sans-serif", bebas: "'Bebas Neue',sans-serif", pay: "'Paytone One',sans-serif",
    ml: "'Baloo Chettan 2','Noto Sans Malayalam',sans-serif", script: "'Galada',cursive", bungee: "'Bungee',sans-serif", right: "'Righteous',sans-serif"
  };
  const FACT = {}; FACT[FONT.anton] = 0.47; FACT[FONT.bebas] = 0.4; FACT[FONT.serif] = 0.57; FACT[FONT.body] = 0.58; FACT[FONT.pay] = 0.6; FACT[FONT.ml] = 0.82; FACT[FONT.script] = 0.5; FACT[FONT.bungee] = 0.72; FACT[FONT.right] = 0.58;
  const fontFactor = css => FACT[css] || 0.58;

  // ------------------------------------------------------------------ palettes
  const PAL = {
    navy: { bg: ['#0B1B3A', '#1E3A8A'], accent: '#FACC15', dark: '#08122B', light: '#F8FAFC', ink: '#0B1B3A' },
    fire: { bg: ['#B91C1C', '#F59E0B'], accent: '#FACC15', dark: '#450A0A', light: '#FFF7ED', ink: '#7F1D1D' },
    emerald: { bg: ['#064E3B', '#10B981'], accent: '#FDE68A', dark: '#022C22', light: '#ECFDF5', ink: '#064E3B' },
    royal: { bg: ['#4C1D95', '#DB2777'], accent: '#FDE68A', dark: '#2E1065', light: '#FDF4FF', ink: '#4C1D95' },
    ocean: { bg: ['#0369A1', '#22D3EE'], accent: '#FDE047', dark: '#082F49', light: '#F0F9FF', ink: '#075985' },
    gold: { bg: ['#1C1917', '#44403C'], accent: '#D4A537', dark: '#0C0A09', light: '#FBF6EA', ink: '#1C1917' },
    rose: { bg: ['#BE185D', '#FB7185'], accent: '#FEF08A', dark: '#500724', light: '#FFF1F2', ink: '#831843' },
    sun: { bg: ['#EA580C', '#FACC15'], accent: '#DC2626', dark: '#431407', light: '#FFFBEB', ink: '#7C2D12' },
    forest: { bg: ['#14532D', '#65A30D'], accent: '#FDE047', dark: '#052E16', light: '#F7FEE7', ink: '#14532D' },
    night: { bg: ['#0F172A', '#334155'], accent: '#38BDF8', dark: '#020617', light: '#F1F5F9', ink: '#0F172A' },
    teal: { bg: ['#0E6E5D', '#14B8A6'], accent: '#CC9A3C', dark: '#052E27', light: '#F0FDFA', ink: '#0E6E5D' },
    berry: { bg: ['#701A75', '#C026D3'], accent: '#FDE68A', dark: '#3B0764', light: '#FDF4FF', ink: '#701A75' },
    cream: { bg: ['#FBF6EA', '#F3ECDA'], accent: '#B8860B', dark: '#3B2A10', light: '#FBF6EA', ink: '#3B2A10' }
  };

  // ------------------------------------------------------------------ small helpers
  function lineCount(text, size, w, css) {
    const f = fontFactor(css); let total = 0;
    String(text).split('\n').forEach(par => {
      const words = par.split(/\s+/).filter(Boolean); let lines = 1, cur = 0; const sp = size * f * 0.35;
      words.forEach(wd => { const ww = wd.length * size * f; if (!cur) cur = ww; else if (cur + sp + ww <= w) cur += sp + ww; else { lines++; cur = ww; } });
      total += lines;
    });
    return total;
  }
  function fitSize(text, css, w, maxLines, base, minS) {
    let s = base; const f = fontFactor(css), longest = Math.max(...String(text).split(/\s+/).map(x => x.length), 1);
    while (s > (minS || 14) && (lineCount(text, s, w, css) > maxLines || longest * s * f > w)) s *= 0.94;
    return Math.floor(s);
  }
  // Text block: returns {h, make(cy)} so the flow layout can place it.
  function block(text, o) {
    const css = o.css || FONT.body, w = o.w, lh = o.lh || 1.12;
    const size = o.fit ? fitSize(text, css, w, o.maxLines || 2, o.size, o.minSize) : o.size;
    const lines = lineCount(text, size, w, css), h = Math.ceil(lines * size * lh);
    return {
      h, size, make: cy => {
        const opts = { width: w, fontFamily: css, fontSize: size, fontWeight: o.weight || 'normal', fill: o.fill || '#fff', textAlign: o.align || 'center', lineHeight: lh, charSpacing: o.spacing || 0, originX: o.align === 'left' ? 'left' : o.align === 'right' ? 'right' : 'center', originY: 'center', left: o.x, top: cy, studioKind: 'text' };
        if (o.stroke) { opts.stroke = o.stroke; opts.strokeWidth = o.strokeW || size * 0.06; opts.paintFirst = 'stroke'; opts.strokeLineJoin = 'round'; }
        if (o.shadow) opts.shadow = new F.Shadow(o.shadow);
        if (o.italic) opts.fontStyle = 'italic';
        return new F.Textbox(text, opts);
      }
    };
  }
  const shadowHard = (col, d) => ({ color: col, blur: 0, offsetX: d, offsetY: d });
  function emoji(ch, x, y, size, angle, op) { return new F.Text(ch, { fontSize: size, fontFamily: EMOJI, originX: 'center', originY: 'center', left: x, top: y, angle: angle || 0, opacity: op == null ? 1 : op, studioKind: 'emoji' }); }
  function rect(x, y, w, h, o) { return new F.Rect(Object.assign({ width: w, height: h, left: x, top: y, originX: 'center', originY: 'center' }, o)); }
  function pill(cx, cy, w, h, fill, o) { return rect(cx, cy, w, h, Object.assign({ fill, rx: h / 2, ry: h / 2 }, o)); }
  function circle(cx, cy, r, o) { return new F.Circle(Object.assign({ radius: r, left: cx, top: cy, originX: 'center', originY: 'center' }, o)); }
  function shape(id, cx, cy, size, fill, o) {
    const p = StudioLib.makeShape(id, fill); const s = size / Math.max(p.width, p.height);
    p.set(Object.assign({ scaleX: s, scaleY: s, left: cx, top: cy, originX: 'center', originY: 'center' }, o || {})); return p;
  }
  function rays(W, H, cx, cy, color, n) {
    const R = Math.hypot(W, H), N = n || 24; let d = '';
    for (let i = 0; i < N; i += 2) { const a1 = i / N * Math.PI * 2, a2 = (i + 1) / N * Math.PI * 2; d += `M${cx} ${cy} L${(cx + Math.cos(a1) * R).toFixed(1)} ${(cy + Math.sin(a1) * R).toFixed(1)} L${(cx + Math.cos(a2) * R).toFixed(1)} ${(cy + Math.sin(a2) * R).toFixed(1)} Z `; }
    return new F.Path(d, { fill: color, studioKind: 'shape', studioName: 'Rays', selectable: true });
  }
  // Stack blocks top->bottom with even gaps (adapts to any canvas height).
  function flow(blocks, H, top, bottom, maxGap) {
    const sum = blocks.reduce((s, b) => s + b.h, 0), n = blocks.length, avail = H - top - bottom;
    let gap = n > 1 ? (avail - sum) / (n - 1) : 0; if (gap < H * 0.008) gap = H * 0.008; if (maxGap && gap > maxGap) gap = maxGap;
    const total = sum + gap * (n - 1); let y = top + Math.max(0, (avail - total) / 2); const out = [];
    blocks.forEach(b => { const r = b.make(y + b.h / 2); Array.isArray(r) ? out.push(...r) : out.push(r); y += b.h + gap; });
    return out;
  }
  const solidBlock = (h, make) => ({ h, make });
  const bgGrad = (c, ang) => ({ type: 'gradient', c1: c.bg[0], c2: c.bg[1], angle: ang == null ? 160 : ang });

  // ------------------------------------------------------------------ layout builders  (return {bg, objs})
  const L = {};

  // Big bold offer with sunburst + badge  (portrait / square / story)
  L.burst = (W, H, c, p) => {
    const u = Math.min(W, H), objs = [], cx = W / 2, tw = W * 0.88;
    objs.push(rays(W, H, cx, H * 0.4, 'rgba(255,255,255,0.13)'));
    objs.push(emoji(c.motif[0], W * 0.13, H * 0.075, u * 0.13, -14), emoji(c.motif[1], W * 0.87, H * 0.075, u * 0.13, 14));
    objs.push(emoji(c.motif[2] || c.motif[0], W * 0.1, H * 0.57, u * 0.1, -10, 0.9), emoji(c.motif[2] || c.motif[1], W * 0.9, H * 0.57, u * 0.1, 10, 0.9));
    const tagW = Math.min(W * 0.7, c.tag.length * u * 0.036 + u * 0.14), tagH = u * 0.075;
    const head = block(c.head, { x: cx, w: tw, css: p.headFont || FONT.anton, size: u * 0.2, fit: true, maxLines: 2, fill: '#ffffff', stroke: p.dark, weight: 'normal', lh: 1.02, shadow: shadowHard(p.dark, u * 0.012), spacing: 20 });
    const sub = block(c.sub, { x: cx, w: W * 0.82, css: FONT.body, size: u * 0.05, fit: true, maxLines: 2, fill: '#ffffff', weight: '700' });
    const ctaW = Math.min(W * 0.7, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.1, bdg = u * 0.34;
    const items = [
      solidBlock(tagH, cy => [pill(cx, cy, tagW, tagH, p.accent), new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: tagH * 0.46, fill: p.dark, charSpacing: 120, originX: 'center', originY: 'center', left: cx, top: cy })]),
      head,
      solidBlock(bdg, cy => new F.Group([shape('burst16', 0, 0, bdg, p.accent), new F.Textbox(c.badge, { width: bdg * 0.7, fontFamily: FONT.anton, fontSize: fitSize(c.badge, FONT.anton, bdg * 0.66, 2, bdg * 0.3, 20), fill: p.dark, textAlign: 'center', originX: 'center', originY: 'center', left: 0, top: 0, lineHeight: 0.95 })], { left: cx, top: cy, originX: 'center', originY: 'center', angle: -8, studioKind: 'multi', studioName: 'Offer badge' })),
      sub,
      solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, p.dark, { shadow: new F.Shadow({ color: 'rgba(0,0,0,.35)', blur: 14, offsetX: 0, offsetY: 6 }) }), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: '#ffffff', originX: 'center', originY: 'center', left: cx, top: cy })]),
      solidBlock(u * 0.04, cy => new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.032, fill: 'rgba(255,255,255,.92)', originX: 'center', originY: 'center', left: cx, top: cy }))
    ];
    return { bg: bgGrad(p, 160), objs: objs.concat(flow(items, H, H * 0.045, H * 0.03, H * 0.06)) };
  };

  // Header band + photo placeholder + price tag
  L.photo = (W, H, c, p) => {
    const u = Math.min(W, H), objs = [], cx = W / 2, bandH = H * 0.16;
    objs.push(rect(cx, bandH / 2, W, bandH, { fill: p.dark }));
    const head = block(c.head, { x: cx, w: W * 0.88, css: p.headFont || FONT.serif, size: u * 0.09, fit: true, maxLines: 2, fill: '#ffffff', weight: '900', lh: 1.05 });
    objs.push(head.make(bandH / 2));
    const pw = W * 0.84, ph = H * 0.44, py = H * 0.2 + ph / 2;
    objs.push(rect(cx, py, pw, ph, { fill: p.light === '#FFFFFF' ? '#f1f5f9' : p.light, stroke: p.bg[0], strokeWidth: u * 0.006, strokeDashArray: [u * 0.03, u * 0.02], rx: u * 0.04, ry: u * 0.04, studioName: 'Photo area' }));
    objs.push(emoji('📷', cx, py - ph * 0.08, Math.min(pw, ph) * 0.22, 0, 0.55));
    objs.push(new F.Text('Add your photo here', { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.034, fill: p.bg[0], opacity: 0.7, originX: 'center', originY: 'center', left: cx, top: py + ph * 0.16 }));
    objs.push(new F.Group([shape('burst12', 0, 0, u * 0.24, p.accent), new F.Textbox(c.badge, { width: u * 0.17, fontFamily: FONT.anton, fontSize: fitSize(c.badge, FONT.anton, u * 0.17, 2, u * 0.07, 14), fill: p.dark, textAlign: 'center', originX: 'center', originY: 'center', left: 0, top: 0, lineHeight: 0.95 })], { left: cx + pw / 2 - u * 0.06, top: H * 0.2 + u * 0.05, originX: 'center', originY: 'center', angle: 10, studioKind: 'multi', studioName: 'Badge' }));
    const sub = block(c.sub, { x: cx, w: W * 0.84, css: FONT.body, size: u * 0.052, fit: true, maxLines: 2, fill: p.ink, weight: '800' });
    const barH = H * 0.13;
    objs.push(sub.make(H * 0.7 + sub.h / 2));
    objs.push(rect(cx, H - barH / 2, W, barH, { fill: p.accent }));
    objs.push(new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: u * 0.058, fill: p.dark, originX: 'center', originY: 'center', left: cx, top: H - barH * 0.64 }));
    objs.push(new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.03, fill: p.dark, originX: 'center', originY: 'center', left: cx, top: H - barH * 0.25 }));
    objs.push(emoji(c.motif[0], W * 0.09, H * 0.69, u * 0.07, -12), emoji(c.motif[1], W * 0.91, H * 0.69, u * 0.07, 12));
    return { bg: p.light, objs };
  };

  // Elegant invitation / festival card
  L.invite = (W, H, c, p, o) => {
    o = o || {}; const u = Math.min(W, H), cx = W / 2, dark = !!o.dark, ink = dark ? '#FBF6EA' : p.ink, acc = dark ? p.accent : (p.accent === '#FACC15' ? '#B8860B' : p.accent), objs = [];
    const m = u * 0.05;
    objs.push(rect(cx, H / 2, W - m * 2, H - m * 2, { fill: 'transparent', stroke: acc, strokeWidth: u * 0.006 }));
    objs.push(rect(cx, H / 2, W - m * 3.2, H - m * 3.2, { fill: 'transparent', stroke: acc, strokeWidth: u * 0.0025 }));
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy]) => objs.push(shape('diamond', cx + sx * (W / 2 - m * 1.6), H / 2 + sy * (H / 2 - m * 1.6), u * 0.035, acc)));
    const iw = W * 0.72, inv = c.invite || {};
    const items = [
      solidBlock(u * 0.12, cy => emoji(c.motif[0], cx, cy, u * 0.11)),
      block(inv.kicker || 'YOU ARE INVITED', { x: cx, w: iw, css: FONT.body, size: u * 0.034, fill: acc, weight: '800', spacing: 360 }),
      block(c.head, { x: cx, w: iw, css: p.headFont || FONT.serif, size: u * 0.12, fit: true, maxLines: 3, fill: ink, weight: '900', lh: 1.08, italic: !!o.italic }),
      solidBlock(u * 0.03, cy => [new F.Line([cx - u * 0.18, cy, cx - u * 0.025, cy], { stroke: acc, strokeWidth: u * 0.004 }), new F.Line([cx + u * 0.025, cy, cx + u * 0.18, cy], { stroke: acc, strokeWidth: u * 0.004 }), shape('diamond', cx, cy, u * 0.03, acc)]),
      block(inv.names || c.sub, { x: cx, w: iw, css: o.script ? FONT.script : FONT.serif, size: u * 0.075, fit: true, maxLines: 2, fill: ink, weight: o.script ? 'normal' : '700', lh: 1.1 }),
      block(inv.line1 || 'Saturday, 12 December 2026  •  6:00 PM', { x: cx, w: iw, css: FONT.body, size: u * 0.04, fit: true, maxLines: 2, fill: ink, weight: '700' }),
      block(inv.line2 || 'Grand Convention Hall, Your City', { x: cx, w: iw, css: FONT.body, size: u * 0.036, fit: true, maxLines: 2, fill: ink, weight: '500' }),
      block(inv.line3 || c.foot, { x: cx, w: iw, css: FONT.body, size: u * 0.03, fill: acc, weight: '800', spacing: 100 })
    ];
    return { bg: dark ? { type: 'gradient', c1: p.bg[0], c2: p.dark, angle: 180 } : p.light, objs: objs.concat(flow(items, H, m * 2.2, m * 2.2, u * 0.05)) };
  };

  // Split: coloured headline panel + big emoji disc
  L.split = (W, H, c, p) => {
    const u = Math.min(W, H), cx = W / 2, objs = [], panelH = H * 0.54;
    objs.push(rect(cx, panelH / 2, W, panelH, { fill: new F.Gradient({ type: 'linear', gradientUnits: 'pixels', coords: { x1: 0, y1: 0, x2: W, y2: panelH }, colorStops: [{ offset: 0, color: p.bg[0] }, { offset: 1, color: p.bg[1] }] }) }));
    objs.push(circle(W * 0.88, H * 0.06, u * 0.2, { fill: 'rgba(255,255,255,0.10)' }), circle(W * 0.06, panelH * 0.9, u * 0.16, { fill: 'rgba(255,255,255,0.08)' }));
    const tag = new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: u * 0.036, fill: p.accent, charSpacing: 300, originX: 'center', originY: 'center', left: cx, top: H * 0.075 });
    objs.push(tag);
    const head = block(c.head, { x: cx, w: W * 0.86, css: p.headFont || FONT.anton, size: u * 0.17, fit: true, maxLines: 3, fill: '#ffffff', lh: 1.05, shadow: shadowHard(p.dark, u * 0.008), spacing: 10 });
    objs.push(head.make(H * 0.1 + (panelH - H * 0.18) / 2 - u * 0.02));
    const dr = u * 0.2;
    objs.push(circle(cx, panelH, dr, { fill: '#ffffff', shadow: new F.Shadow({ color: 'rgba(0,0,0,.22)', blur: 26, offsetX: 0, offsetY: 10 }) }));
    objs.push(emoji(c.motif[0], cx, panelH, dr * 1.1));
    const sub = block(c.sub, { x: cx, w: W * 0.82, css: FONT.body, size: u * 0.052, fit: true, maxLines: 3, fill: p.ink, weight: '800' });
    const ctaW = Math.min(W * 0.7, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.1;
    const rest = [sub, solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, p.accent === '#FACC15' ? p.bg[0] : p.accent), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: '#ffffff', originX: 'center', originY: 'center', left: cx, top: cy })]), solidBlock(u * 0.04, cy => new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.032, fill: p.ink, originX: 'center', originY: 'center', left: cx, top: cy }))];
    return { bg: p.light, objs: objs.concat(flow(rest, H, panelH + dr + u * 0.03, H * 0.03, u * 0.06)) };
  };

  // Minimal: left aligned, accent bar, large circle
  L.minimal = (W, H, c, p) => {
    const u = Math.min(W, H), objs = [], lx = W * 0.1, tw = W * 0.8;
    objs.push(circle(W * 0.92, H * 0.12, u * 0.36, { fill: p.bg[0], opacity: 0.95 }), circle(W * 0.92, H * 0.12, u * 0.24, { fill: p.accent, opacity: 0.9 }));
    objs.push(emoji(c.motif[0], W * 0.84, H * 0.84, u * 0.22, -8));
    objs.push(rect(W * 0.04, H / 2, u * 0.016, H * 0.5, { fill: p.accent }));
    const ctaW = Math.min(W * 0.6, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.1;
    const items = [
      block(c.tag, { x: lx, w: tw, align: 'left', css: FONT.body, size: u * 0.036, fill: p.bg[0], weight: '800', spacing: 300 }),
      block(c.head, { x: lx, w: tw * 0.9, align: 'left', css: p.headFont || FONT.serif, size: u * 0.15, fit: true, maxLines: 3, fill: p.ink, weight: '900', lh: 1.04 }),
      block(c.sub, { x: lx, w: tw * 0.8, align: 'left', css: FONT.body, size: u * 0.05, fit: true, maxLines: 3, fill: '#475569', weight: '600' }),
      solidBlock(ctaH, cy => [pill(lx + ctaW / 2, cy, ctaW, ctaH, p.bg[0]), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: '#ffffff', originX: 'center', originY: 'center', left: lx + ctaW / 2, top: cy })]),
      block(c.foot, { x: lx, w: tw, align: 'left', css: FONT.body, size: u * 0.032, fill: p.ink, weight: '700' })
    ];
    return { bg: p.light, objs: objs.concat(flow(items, H, H * 0.2, H * 0.08, u * 0.05)) };
  };

  // YouTube-style thumbnail / wide social post (landscape)
  L.thumb = (W, H, c, p) => {
    const objs = [], u = H;
    objs.push(rays(W, H, W * 0.74, H * 0.5, 'rgba(255,255,255,0.14)', 28));
    objs.push(circle(W * 0.74, H * 0.5, u * 0.36, { fill: p.accent, stroke: '#ffffff', strokeWidth: u * 0.02 }));
    objs.push(emoji(c.motif[0], W * 0.74, H * 0.5, u * 0.46));
    objs.push(emoji(c.motif[1], W * 0.9, H * 0.16, u * 0.14, 14), emoji(c.motif[2] || c.motif[1], W * 0.58, H * 0.86, u * 0.12, -12));
    const head = block(c.head, { x: W * 0.05, w: W * 0.5, align: 'left', css: FONT.anton, size: u * 0.26, fit: true, maxLines: 3, fill: '#ffffff', stroke: p.dark, strokeW: u * 0.025, lh: 1.0, shadow: shadowHard(p.dark, u * 0.015), spacing: 10 });
    const sub = block(c.sub, { x: W * 0.05, w: W * 0.5, align: 'left', css: FONT.body, size: u * 0.07, fit: true, maxLines: 2, fill: p.accent, weight: '800', stroke: p.dark, strokeW: u * 0.012 });
    const tagW = c.tag.length * u * 0.045 + u * 0.14, tagH = u * 0.11;
    const items = [solidBlock(tagH, cy => [pill(W * 0.05 + tagW / 2, cy, tagW, tagH, p.accent), new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: tagH * 0.45, fill: p.dark, charSpacing: 100, originX: 'center', originY: 'center', left: W * 0.05 + tagW / 2, top: cy })]), head, sub];
    return { bg: bgGrad(p, 120), objs: objs.concat(flow(items, H, H * 0.08, H * 0.08, H * 0.05)) };
  };

  // Wide banner (website / ad / facebook)
  L.wide = (W, H, c, p) => {
    const u = H, objs = [], lx = W * 0.05, tw = W * 0.55;
    objs.push(circle(W * 0.86, H * 0.5, u * 0.62, { fill: 'rgba(255,255,255,0.10)' }), circle(W * 0.86, H * 0.5, u * 0.42, { fill: 'rgba(255,255,255,0.12)' }));
    objs.push(emoji(c.motif[0], W * 0.82, H * 0.52, u * 0.62), emoji(c.motif[1], W * 0.93, H * 0.2, u * 0.2, 12), emoji(c.motif[2] || c.motif[1], W * 0.72, H * 0.86, u * 0.16, -10));
    const ctaW = c.cta.length * u * 0.065 + u * 0.3, ctaH = u * 0.17;
    const items = [
      block(c.tag, { x: lx, w: tw, align: 'left', css: FONT.body, size: u * 0.07, fill: p.accent, weight: '800', spacing: 300 }),
      block(c.head, { x: lx, w: tw, align: 'left', css: p.headFont || FONT.anton, size: u * 0.26, fit: true, maxLines: 2, fill: '#ffffff', lh: 1.03, shadow: shadowHard(p.dark, u * 0.01), spacing: 10 }),
      block(c.sub, { x: lx, w: tw, align: 'left', css: FONT.body, size: u * 0.075, fit: true, maxLines: 2, fill: 'rgba(255,255,255,.95)', weight: '700' }),
      solidBlock(ctaH, cy => [pill(lx + ctaW / 2, cy, ctaW, ctaH, p.accent), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.45, fill: p.dark, originX: 'center', originY: 'center', left: lx + ctaW / 2, top: cy })])
    ];
    return { bg: bgGrad(p, 110), objs: objs.concat(flow(items, H, H * 0.08, H * 0.08, H * 0.05)) };
  };

  // Tall story (Instagram story / WhatsApp status)
  L.story = (W, H, c, p) => {
    const u = W, objs = [], cx = W / 2;
    objs.push(circle(W * 0.9, H * 0.08, u * 0.35, { fill: 'rgba(255,255,255,0.09)' }), circle(W * 0.05, H * 0.55, u * 0.28, { fill: 'rgba(255,255,255,0.08)' }), circle(W * 0.8, H * 0.9, u * 0.3, { fill: 'rgba(255,255,255,0.08)' }));
    const disc = u * 0.7, ctaW = Math.min(W * 0.76, c.cta.length * u * 0.05 + u * 0.24), ctaH = u * 0.12;
    const items = [
      solidBlock(u * 0.09, cy => pill(cx, cy, Math.min(W * 0.75, c.tag.length * u * 0.04 + u * 0.16), u * 0.09, p.accent)),
      block(c.head, { x: cx, w: W * 0.88, css: p.headFont || FONT.anton, size: u * 0.2, fit: true, maxLines: 3, fill: '#ffffff', lh: 1.02, stroke: p.dark, strokeW: u * 0.012, shadow: shadowHard(p.dark, u * 0.01), spacing: 10 }),
      solidBlock(disc, cy => [circle(cx, cy, disc / 2, { fill: 'rgba(255,255,255,0.95)', shadow: new F.Shadow({ color: 'rgba(0,0,0,.25)', blur: 30, offsetX: 0, offsetY: 12 }) }), emoji(c.motif[0], cx, cy, disc * 0.6), emoji(c.motif[1], cx + disc * 0.42, cy - disc * 0.38, disc * 0.22, 12)]),
      block(c.sub, { x: cx, w: W * 0.82, css: FONT.body, size: u * 0.06, fit: true, maxLines: 3, fill: '#ffffff', weight: '700' }),
      solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, p.accent), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: p.dark, originX: 'center', originY: 'center', left: cx, top: cy })]),
      block(c.foot, { x: cx, w: W * 0.88, css: FONT.body, size: u * 0.036, fill: 'rgba(255,255,255,.9)', weight: '700' })
    ];
    // Put the tag text on the pill
    const out = flow(items, H, H * 0.07, H * 0.06, H * 0.05);
    const pillObj = out[0]; out.splice(1, 0, new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: u * 0.038, fill: p.dark, charSpacing: 160, originX: 'center', originY: 'center', left: cx, top: pillObj.top }));
    return { bg: bgGrad(p, 165), objs: objs.concat(out) };
  };

  // ---- extra layouts (v2) -------------------------------------------------------------
  // Diagonal: bold headline on gradient, light diagonal panel with badge + emoji
  L.diag = (W, H, c, p) => {
    const u = Math.min(W, H), cx = W / 2, objs = [];
    objs.push(rays(W, H, W * 0.2, H * 0.15, 'rgba(255,255,255,0.10)', 20));
    objs.push(emoji(c.motif[0], W * 0.1, H * 0.085, u * 0.11, -12), emoji(c.motif[1], W * 0.9, H * 0.075, u * 0.1, 12));
    objs.push(new F.Polygon([{ x: 0, y: H * 0.40 }, { x: W, y: H * 0.30 }, { x: W, y: H * 0.325 }, { x: 0, y: H * 0.425 }], { left: 0, top: H * 0.30, fill: p.accent }));
    objs.push(new F.Polygon([{ x: 0, y: H * 0.425 }, { x: W, y: H * 0.325 }, { x: W, y: H }, { x: 0, y: H }], { left: 0, top: H * 0.325, fill: p.light }));
    const tagW = Math.min(W * 0.7, c.tag.length * u * 0.034 + u * 0.14), tagH = u * 0.06;
    objs.push(pill(cx, H * 0.065, tagW, tagH, p.accent), new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: tagH * 0.46, fill: p.dark, charSpacing: 120, originX: 'center', originY: 'center', left: cx, top: H * 0.065 }));
    objs.push(block(c.head, { x: cx, w: W * 0.86, css: p.headFont || FONT.anton, size: Math.min(u * 0.15, H * 0.1), fit: true, maxLines: 2, fill: '#ffffff', stroke: p.dark, lh: 1.04, shadow: shadowHard(p.dark, u * 0.01), spacing: 10 }).make(H * 0.19));
    const bd = u * 0.27;
    objs.push(new F.Group([shape('burst16', 0, 0, bd, p.accent), new F.Textbox(c.badge, { width: bd * 0.68, fontFamily: FONT.anton, fontSize: fitSize(c.badge, FONT.anton, bd * 0.62, 2, bd * 0.26, 16), fill: p.dark, textAlign: 'center', originX: 'center', originY: 'center', left: 0, top: 0, lineHeight: 0.95 })], { left: W * 0.8, top: H * 0.45, originX: 'center', originY: 'center', angle: 8, studioKind: 'multi', studioName: 'Offer badge' }));
    objs.push(emoji(c.motif[2] || c.motif[0], W * 0.2, H * 0.46, u * 0.26, -8));
    const ctaW = Math.min(W * 0.7, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.1;
    const rest = [block(c.sub, { x: cx, w: W * 0.8, css: FONT.body, size: u * 0.05, fit: true, maxLines: 2, fill: p.ink, weight: '800' }),
      solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, p.bg[0]), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: '#fff', originX: 'center', originY: 'center', left: cx, top: cy })]),
      solidBlock(u * 0.04, cy => new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.032, fill: p.ink, originX: 'center', originY: 'center', left: cx, top: cy }))];
    return { bg: bgGrad(p, 150), objs: objs.concat(flow(rest, H, H * 0.6, H * 0.03, u * 0.05)) };
  };

  // Ornate frame: double border, centre disc with emoji
  L.frame = (W, H, c, p) => {
    const u = Math.min(W, H), cx = W / 2, m = u * 0.045, objs = [];
    objs.push(rays(W, H, cx, H * 0.45, 'rgba(255,255,255,0.09)', 28));
    objs.push(rect(cx, H / 2, W - m * 2, H - m * 2, { fill: 'transparent', stroke: p.accent, strokeWidth: u * 0.008 }), rect(cx, H / 2, W - m * 3, H - m * 3, { fill: 'transparent', stroke: 'rgba(255,255,255,0.55)', strokeWidth: u * 0.003 }));
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sy]) => objs.push(shape('star4', cx + sx * (W / 2 - m * 1.5), H / 2 + sy * (H / 2 - m * 1.5), u * 0.07, p.accent)));
    const disc = Math.min(u * 0.4, H * 0.28), tagH = u * 0.06, tagW = Math.min(W * 0.7, c.tag.length * u * 0.034 + u * 0.14);
    const ctaW = Math.min(W * 0.66, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.095;
    const items = [
      solidBlock(tagH, cy => [pill(cx, cy, tagW, tagH, p.accent), new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: tagH * 0.46, fill: p.dark, charSpacing: 120, originX: 'center', originY: 'center', left: cx, top: cy })]),
      block(c.head, { x: cx, w: W * 0.76, css: p.headFont || FONT.serif, size: Math.min(u * 0.12, H * 0.085), fit: true, maxLines: 2, fill: '#ffffff', weight: '900', lh: 1.05, shadow: shadowHard(p.dark, u * 0.006) }),
      solidBlock(disc, cy => [circle(cx, cy, disc / 2, { fill: 'rgba(255,255,255,0.96)', stroke: p.accent, strokeWidth: u * 0.012 }), emoji(c.motif[0], cx, cy, disc * 0.58), emoji(c.motif[1], cx - disc * 0.52, cy - disc * 0.34, disc * 0.2, -12), emoji(c.motif[2] || c.motif[1], cx + disc * 0.52, cy + disc * 0.3, disc * 0.18, 12)]),
      block(c.sub, { x: cx, w: W * 0.72, css: FONT.body, size: u * 0.045, fit: true, maxLines: 2, fill: '#ffffff', weight: '700' }),
      solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, p.accent), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: p.dark, originX: 'center', originY: 'center', left: cx, top: cy })]),
      solidBlock(u * 0.035, cy => new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.028, fill: 'rgba(255,255,255,.92)', originX: 'center', originY: 'center', left: cx, top: cy }))
    ];
    return { bg: bgGrad(p, 160), objs: objs.concat(flow(items, H, m * 2.4, m * 2.2, u * 0.045)) };
  };

  // Retail stripe: coloured header band, emoji disc, badge, accent footer bar
  L.stripe = (W, H, c, p) => {
    const u = Math.min(W, H), cx = W / 2, bandH = H * 0.24, objs = [];
    objs.push(rect(cx, bandH / 2, W, bandH, { fill: p.bg[0] }), rect(cx, bandH, W, u * 0.014, { fill: p.accent }));
    for (let i = 0; i < 9; i++) objs.push(rect(W * i / 8, bandH / 2, u * 0.03, bandH, { fill: 'rgba(255,255,255,0.07)', angle: 25 }));
    objs.push(new F.Text(c.tag, { fontFamily: FONT.body, fontWeight: '800', fontSize: u * 0.03, fill: p.accent, charSpacing: 300, originX: 'center', originY: 'center', left: cx, top: bandH * 0.18 }));
    objs.push(block(c.head, { x: cx, w: W * 0.88, css: p.headFont || FONT.anton, size: Math.min(u * 0.11, bandH * 0.4), fit: true, maxLines: 2, fill: '#ffffff', lh: 1.05 }).make(bandH * 0.6));
    const r = Math.min(u * 0.2, H * 0.17), dy = H * 0.46;
    objs.push(circle(cx, dy, r, { fill: p.bg[1], stroke: p.accent, strokeWidth: u * 0.012 }), emoji(c.motif[0], cx, dy, r * 1.15), emoji(c.motif[1], cx - r * 1.35, dy + r * 0.5, r * 0.4, -12), emoji(c.motif[2] || c.motif[1], cx - r * 1.2, dy - r * 0.7, r * 0.3, 10));
    const bd = u * 0.22;
    objs.push(new F.Group([shape('burst12', 0, 0, bd, p.accent), new F.Textbox(c.badge, { width: bd * 0.66, fontFamily: FONT.anton, fontSize: fitSize(c.badge, FONT.anton, bd * 0.6, 2, bd * 0.26, 14), fill: p.dark, textAlign: 'center', originX: 'center', originY: 'center', left: 0, top: 0, lineHeight: 0.95 })], { left: cx + r * 1.2, top: dy - r * 0.7, originX: 'center', originY: 'center', angle: 12, studioKind: 'multi', studioName: 'Badge' }));
    objs.push(block(c.sub, { x: cx, w: W * 0.82, css: FONT.body, size: u * 0.05, fit: true, maxLines: 2, fill: p.ink, weight: '800' }).make(H * 0.72));
    const barH = H * 0.14;
    objs.push(rect(cx, H - barH / 2, W, barH, { fill: p.accent }), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: fitSize(c.cta, FONT.body, W * 0.84, u * 0.056, '800'), fill: p.dark, originX: 'center', originY: 'center', left: cx, top: H - barH * 0.64 }), new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.03, fill: p.dark, originX: 'center', originY: 'center', left: cx, top: H - barH * 0.25 }));
    return { bg: p.light, objs };
  };

  // Neon night: dark gradient, glowing headline and outlined button
  L.neon = (W, H, c, p) => {
    const u = Math.min(W, H), cx = W / 2, m = u * 0.05, glow = p.accent, objs = [], gl = { color: glow, blur: 30, offsetX: 0, offsetY: 0 };
    objs.push(circle(W * 0.85, H * 0.12, u * 0.3, { fill: 'rgba(255,255,255,0.05)' }), circle(W * 0.1, H * 0.85, u * 0.34, { fill: 'rgba(255,255,255,0.04)' }));
    objs.push(rect(cx, H / 2, W - m * 2, H - m * 2, { fill: 'transparent', stroke: glow, strokeWidth: u * 0.006, rx: u * 0.04, ry: u * 0.04, shadow: new F.Shadow(gl) }));
    const disc = Math.min(u * 0.34, H * 0.24), ctaW = Math.min(W * 0.66, c.cta.length * u * 0.045 + u * 0.2), ctaH = u * 0.095;
    const items = [
      block(c.tag, { x: cx, w: W * 0.8, css: FONT.body, size: u * 0.034, fill: glow, weight: '800', spacing: 400 }),
      block(c.head, { x: cx, w: W * 0.8, css: p.headFont || FONT.anton, size: Math.min(u * 0.14, H * 0.1), fit: true, maxLines: 2, fill: '#ffffff', lh: 1.05, shadow: { color: glow, blur: 40, offsetX: 0, offsetY: 0 }, spacing: 20 }),
      solidBlock(disc, cy => [emoji(c.motif[0], cx, cy, disc * 0.85), emoji(c.motif[1], cx - disc * 0.7, cy - disc * 0.2, disc * 0.25, -10), emoji(c.motif[2] || c.motif[1], cx + disc * 0.7, cy + disc * 0.15, disc * 0.22, 10)]),
      block(c.sub, { x: cx, w: W * 0.72, css: FONT.body, size: u * 0.045, fit: true, maxLines: 2, fill: 'rgba(255,255,255,.9)', weight: '600' }),
      solidBlock(ctaH, cy => [pill(cx, cy, ctaW, ctaH, 'transparent', { stroke: glow, strokeWidth: u * 0.006, shadow: new F.Shadow(gl) }), new F.Text(c.cta, { fontFamily: FONT.body, fontWeight: '800', fontSize: ctaH * 0.42, fill: glow, originX: 'center', originY: 'center', left: cx, top: cy })]),
      solidBlock(u * 0.035, cy => new F.Text(c.foot, { fontFamily: FONT.body, fontWeight: '700', fontSize: u * 0.028, fill: 'rgba(255,255,255,.75)', originX: 'center', originY: 'center', left: cx, top: cy }))
    ];
    return { bg: { type: 'gradient', c1: p.dark, c2: p.bg[0], angle: 180 }, objs: objs.concat(flow(items, H, m * 2.2, m * 2.2, u * 0.05)) };
  };

  // ------------------------------------------------------------------ categories
  const FOOT = '📞 98765 43210   📍 Your Location';
  const SZ = { post: [1080, 1080], port: [1080, 1350], story: [1080, 1920], thumb: [1280, 720], fb: [1200, 630], banner: [1920, 600], a4: [1240, 1754] };
  // [id, label, size, [layoutA, paletteA], [layoutB, paletteB], motif, head, tag, sub, cta, badge, extra]
  const CATS = [
    ['business', 'Business Posters', 'port', ['minimal', 'teal'], ['split', 'navy'], ['💼', '📈', '🤝'], 'GROW YOUR BUSINESS', 'SMART SOLUTIONS', 'Professional services designed to take your brand to the next level.', 'Contact Us Today', 'BEST\nPRICE'],
    ['offer', 'Offer Posters', 'port', ['burst', 'fire'], ['photo', 'sun'], ['🔥', '🎁', '💥'], 'MEGA OFFER', 'LIMITED TIME', 'Grab the best deals before they are gone!', 'Shop Now', '50%\nOFF'],
    ['discount', 'Discount Posters', 'post', ['burst', 'royal'], ['split', 'rose'], ['💸', '🏷️', '🔥'], 'FLAT 50% OFF', 'DISCOUNT DAYS', 'On all products. Hurry, offer valid till stock lasts.', 'Visit Store', '50%\nOFF'],
    ['sale', 'Sale Posters', 'port', ['burst', 'navy'], ['photo', 'fire'], ['🛍️', '⚡', '🎯'], 'BIG SALE', 'END OF SEASON', 'Up to 70% off on all items. Do not miss out!', 'Shop Now', 'UP TO\n70%'],
    ['festival', 'Festival Posters', 'port', ['split', 'sun'], ['burst', 'royal'], ['🪔', '🎆', '✨'], 'HAPPY FESTIVAL', 'FESTIVE GREETINGS', 'Wishing you light, joy and prosperity.', 'Festival Offers', 'FESTIVE\nSALE'],
    ['ramadan', 'Ramadan Posters', 'port', ['invite', 'emerald', { dark: true }], ['split', 'gold'], ['🌙', '🕌', '⭐'], 'RAMADAN KAREEM', 'BLESSED MONTH', 'May this holy month bring peace and happiness.', 'Special Iftar Offers', 'IFTAR\nOFFER', { kicker: 'WISHING YOU A BLESSED', names: 'Ramadan Mubarak', line1: 'May Allah accept your fasting and prayers', line2: 'From our family to yours', line3: 'YOUR SHOP NAME' }],
    ['eid', 'Eid Posters', 'post', ['invite', 'gold', { dark: true }], ['burst', 'emerald'], ['🌙', '✨', '🕌'], 'EID MUBARAK', 'EID SPECIAL', 'Celebrate Eid with exciting offers and festive joy.', 'Shop Eid Collection', 'EID\nSALE', { kicker: 'WITH WARMEST WISHES', names: 'Eid Mubarak', line1: 'May this Eid bring happiness to your home', line2: 'Taqabbalallahu minna wa minkum', line3: 'YOUR SHOP NAME' }],
    ['islamic', 'Islamic Posters', 'port', ['invite', 'emerald'], ['minimal', 'emerald'], ['🕋', '🤲', '🌙'], 'JUMUA MUBARAK', 'FRIDAY BLESSINGS', 'The best of you are those who learn and teach.', 'Share the Blessing', 'DUA', { kicker: 'FRIDAY REMINDER', names: 'The best among you are those who learn and teach.', line1: 'Jumua Mubarak', line2: 'May your prayers be accepted', line3: 'YOUR MASJID / ORGANISATION' }],
    ['birthday', 'Birthday Posters', 'post', ['burst', 'berry'], ['invite', 'rose', { script: true }], ['🎂', '🎈', '🎉'], 'HAPPY BIRTHDAY', 'CELEBRATE!', 'Wishing you a day filled with love, laughter and cake.', 'Join the Party', 'MAKE A\nWISH', { kicker: "YOU'RE INVITED TO", names: 'Aisha turns 5!', line1: 'Sunday, 15 December  •  4:00 PM', line2: 'Rainbow Party Hall, Your City', line3: 'RSVP: 98765 43210' }],
    ['wedding', 'Wedding Invitations', 'port', ['invite', 'cream', { script: true }], ['invite', 'gold', { dark: true, script: true }], ['💍', '💐', '✨'], 'Wedding Invitation', 'SAVE THE DATE', 'Together with their families', 'RSVP', 'WED', { kicker: 'TOGETHER WITH THEIR FAMILIES', names: 'Aisha  &  Rahul', line1: 'Saturday, 12 December 2026  •  11:00 AM', line2: 'Royal Garden Auditorium, Your City', line3: 'RSVP: 98765 43210' }],
    ['engagement', 'Engagement Invitations', 'port', ['invite', 'rose', { script: true }], ['invite', 'navy', { dark: true }], ['💍', '🥂', '💖'], "We're Engaged!", 'ENGAGEMENT', 'Join us to celebrate our engagement', 'RSVP', 'SAVE', { kicker: 'JOIN US TO CELEBRATE', names: 'Fathima  &  Arjun', line1: 'Sunday, 20 December 2026  •  5:00 PM', line2: 'Blue Lagoon Banquet Hall, Your City', line3: 'RSVP: 98765 43210' }],
    ['bizad', 'Business Advertisements', 'post', ['photo', 'navy'], ['split', 'teal'], ['📣', '🏆', '🎯'], 'YOUR BRAND NAME', 'NOW OPEN', 'Quality products and services you can trust.', 'Call Now', 'NEW'],
    ['food', 'Food Posters', 'post', ['photo', 'sun'], ['burst', 'fire'], ['🍔', '🍕', '🍟'], 'TASTE THE DIFFERENCE', 'FRESH & HOT', 'Freshly made with love, served with a smile.', 'Order Now', 'BUY 1\nGET 1'],
    ['restaurant', 'Restaurant Posters', 'port', ['photo', 'forest'], ['minimal', 'sun'], ['🍛', '🥘', '☕'], "TODAY'S SPECIAL", 'FAMILY RESTAURANT', 'Authentic taste. Dine in, take away or home delivery.', 'Call to Reserve', 'FREE\nHOME\nDELIVERY'],
    ['fashion', 'Fashion Posters', 'port', ['minimal', 'rose'], ['photo', 'berry'], ['👗', '👠', '👜'], 'NEW COLLECTION', 'FASHION WEEK', 'Discover the latest trends and styles for the season.', 'Explore Now', 'NEW'],
    ['clothing', 'Clothing Posters', 'post', ['burst', 'ocean'], ['photo', 'night'], ['👕', '👖', '🧢'], 'SEASON SALE', 'MEN  •  WOMEN  •  KIDS', 'Branded clothing at unbeatable prices.', 'Visit Showroom', 'UP TO\n60%'],
    ['jewellery', 'Jewellery Posters', 'port', ['invite', 'gold', { dark: true }], ['photo', 'royal'], ['💍', '💎', '👑'], 'GOLD COLLECTION', 'EXCLUSIVE', 'Timeless designs crafted for every celebration.', 'Visit Our Showroom', 'LOW\nMAKING\nCHARGE', { kicker: 'PRESENTING OUR', names: 'Bridal & Festive Jewellery', line1: 'Gold  •  Diamond  •  Silver', line2: 'Special making charge offer this season', line3: 'YOUR JEWELLERS' }],
    ['beauty', 'Beauty Salon Posters', 'port', ['minimal', 'berry'], ['photo', 'rose'], ['💄', '💇', '💅'], 'BRIDAL MAKEUP', 'BEAUTY SALON', 'Hair, skin and makeup by expert professionals.', 'Book Appointment', '20%\nOFF'],
    ['realestate', 'Real Estate Posters', 'post', ['photo', 'navy'], ['split', 'forest'], ['🏠', '🔑', '🏡'], 'DREAM HOME FOR SALE', 'PREMIUM VILLAS', 'Spacious 3 BHK homes in a prime, peaceful location.', 'Book a Site Visit', 'READY\nTO MOVE'],
    ['education', 'Education Posters', 'port', ['split', 'ocean'], ['minimal', 'navy'], ['🎓', '📚', '✏️'], 'ADMISSIONS OPEN', 'ACADEMIC YEAR 2026–27', 'Quality education with experienced faculty and modern facilities.', 'Enrol Today', 'LIMITED\nSEATS'],
    ['political', 'Political Posters', 'port', ['split', 'navy'], ['photo', 'forest'], ['🗳️', '🇮🇳', '🤝'], 'VOTE FOR CHANGE', 'YOUR NAME  •  CANDIDATE', 'Together we build a better tomorrow for our ward.', 'Your Vote, Your Voice', 'VOTE'],
    ['event', 'Event Posters', 'port', ['burst', 'royal'], ['invite', 'night', { dark: true }], ['🎤', '🎶', '🎉'], 'LIVE EVENT', 'DON\'T MISS', 'Music, food, fun and entertainment for the whole family.', 'Get Tickets', 'FREE\nENTRY', { kicker: 'YOU ARE INVITED TO', names: 'Annual Cultural Night', line1: 'Friday, 18 December  •  6:30 PM', line2: 'Town Hall Ground, Your City', line3: 'ENTRY FREE  •  ALL WELCOME' }],
    ['youtube', 'YouTube Thumbnails', 'thumb', ['thumb', 'fire'], ['thumb', 'royal'], ['😮', '🔥', '👉'], "YOU WON'T BELIEVE THIS!", 'NEW VIDEO', 'Watch till the end', 'Watch Now', 'WOW'],
    ['igpost', 'Instagram Posts', 'post', ['burst', 'berry'], ['minimal', 'teal'], ['✨', '📸', '💖'], 'NEW POST', 'FOLLOW US', 'Share your story with the world.', 'Follow @yourbrand', 'NEW'],
    ['igstory', 'Instagram Stories', 'story', ['story', 'royal'], ['story', 'ocean'], ['📸', '✨', '💖'], 'SWIPE UP', 'NEW STORY', 'Tap to see our latest offers and updates.', 'Swipe Up', 'NEW'],
    ['fbpost', 'Facebook Posts', 'fb', ['wide', 'navy'], ['thumb', 'ocean'], ['👍', '📣', '🎉'], 'BIG ANNOUNCEMENT', 'LATEST NEWS', 'Something exciting is coming soon. Stay tuned!', 'Learn More', 'NEW'],
    ['wastatus', 'WhatsApp Status', 'story', ['story', 'emerald'], ['burst', 'forest'], ['💬', '🎁', '🔥'], 'TODAY\'S OFFER', 'STATUS UPDATE', 'Message us now to order. Fast delivery available.', 'Message Us', 'HOT\nDEAL'],
    ['banner', 'Business Banners', 'banner', ['wide', 'teal'], ['wide', 'fire'], ['🛍️', '🎁', '🔥'], 'GRAND OPENING SALE', 'WELCOME OFFER', 'Everything at special launch prices.', 'Shop Now', 'NEW'],
    ['product', 'Product Advertisements', 'post', ['photo', 'ocean'], ['burst', 'navy'], ['📦', '⭐', '🚚'], 'NEW ARRIVAL', 'JUST LAUNCHED', 'Premium quality at an affordable price. Free delivery.', 'Order Now', 'NEW\nLAUNCH']
  ];
  const templates = [];
  CATS.forEach((c, ci) => {
    const [id, label, sz, A_, B_, motif, head, tag, sub, cta, badge, invite] = c;
    [A_, B_].forEach((v, vi) => {
      templates.push({ id: `${id}-${vi + 1}`, cat: id, catLabel: label, name: `${label.replace(/ (Posters|Invitations|Advertisements|Thumbnails|Posts|Stories|Banners|Status)$/, '')} ${vi + 1}`, size: sz, layout: v[0], pal: v[1], opts: v[2] || {}, motif, head, tag, sub, cta, badge, invite, foot: FOOT, premium: (ci * 2 + vi) % 4 === 3 });
    });
  });
  // ------------------------------------------------------------------ multilingual packs (v2)
  // Languages: English, Malayalam, Tamil, Kannada, Hindi. Each pack drives 3 layouts per category.
  const LANGS = { en: 'English', ml: 'മലയാളം', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', hi: 'हिन्दी' };
  const LANG_TAGS = { en: 'english', ml: 'malayalam മലയാളം', ta: 'tamil தமிழ்', kn: 'kannada ಕನ್ನಡ', hi: 'hindi हिन्दी' };
  const LF = { ml: "'Baloo Chettan 2','Noto Sans Malayalam',sans-serif", ta: "'Baloo Thambi 2','Noto Sans Tamil',sans-serif", kn: "'Baloo Tamma 2','Noto Sans Kannada',sans-serif", hi: "'Baloo 2','Noto Sans Devanagari',sans-serif" };
  Object.values(LF).forEach(f => { FACT[f] = 0.82; });
  const LFOOT = { en: 'Your Location', ml: 'നിങ്ങളുടെ സ്ഥലം', ta: 'உங்கள் இடம்', kn: 'ನಿಮ್ಮ ಸ್ಥಳ', hi: 'आपका स्थान' };
  const P = (head, tag, sub, cta, badge, inv) => ({ head, tag, sub, cta, badge, inv });
  const PACKS = {
    en: {
      offer: P('MEGA OFFER', 'TODAY ONLY', 'Huge discounts on everything. Hurry!', 'Shop Now', '50%\nOFF'),
      sale: P('BIG SALE', 'SEASON END', "Up to 70% off. Don't miss this chance!", 'Shop Now', 'UP TO\n70%'),
      festival: P('HAPPY FESTIVAL', 'GREETINGS', 'Wishing you a festival full of joy and prosperity.', 'Festive Offers', 'FESTIVE\nOFFER'),
      eid: P('EID MUBARAK', 'EID GREETINGS', 'Heartfelt Eid wishes to you and your family.', 'Eid Collection', 'EID\nSALE'),
      birthday: P('HAPPY BIRTHDAY', 'CELEBRATE', 'A day full of love and laughter!', 'Join the Party', 'WISH'),
      wedding: P('WEDDING INVITATION', 'SAVE THE DATE', 'We joyfully invite you to our wedding', 'RSVP', 'WED', { kicker: 'TOGETHER WITH THEIR FAMILIES', names: 'Aisha  &  Rahul', line1: 'Saturday, 12 December 2026  •  11:00 AM', line2: 'Royal Garden Auditorium, Your City', line3: 'RSVP: 98765 43210' }),
      food: P('TASTE THE FESTIVAL', 'FRESH & HOT', 'Delicious food made with love.', 'Order Now', 'HOME\nDELIVERY'),
      jewellery: P('GOLD COLLECTION', 'NEW ARRIVALS', 'Beautiful designs for every celebration.', 'Visit Showroom', 'LOW\nMAKING'),
      education: P('ADMISSIONS OPEN', 'NEW ACADEMIC YEAR', 'Experienced teachers and modern facilities.', 'Join Today', 'LIMITED\nSEATS'),
      realestate: P('DREAM HOME FOR SALE', 'PREMIUM VILLAS', 'Spacious 3 BHK homes at a prime location.', 'Book a Visit', 'READY\nTO MOVE'),
      event: P('LIVE EVENT', "DON'T MISS", 'Music, food and fun for the whole family.', 'Get Tickets', 'FREE\nENTRY'),
      business: P('GROW YOUR BUSINESS', 'SMART SOLUTIONS', 'Services that take your brand to the next level.', 'Contact Us Now', 'BEST\nPRICE'),
      fashion: P('NEW COLLECTION', 'FASHION WEEK', 'Discover the latest trends of the season.', 'Explore Now', 'NEW'),
      opening: P('GRAND OPENING', 'STARTS TOMORROW', 'Special launch offers — everyone is welcome!', 'Visit Us', 'OPENING\nOFFER')
    },
    ml: {
      offer: P('മെഗാ ഓഫർ', 'ഇന്ന് മാത്രം', 'എല്ലാ സാധനങ്ങൾക്കും വമ്പിച്ച വിലക്കുറവ്. വേഗം വരൂ!', 'ഇപ്പോൾ വാങ്ങൂ', '50%\nകിഴിവ്'),
      sale: P('വമ്പൻ സെയിൽ', 'സീസൺ എൻഡ്', '70% വരെ വിലക്കുറവ്. ഈ അവസരം നഷ്ടപ്പെടുത്തരുത്!', 'ഇപ്പോൾ വാങ്ങൂ', '70% വരെ'),
      festival: P('ഉത്സവ ആശംസകൾ', 'ആശംസകൾ', 'സന്തോഷവും സമൃദ്ധിയും നിറഞ്ഞ ഉത്സവകാലം നേരുന്നു.', 'ഉത്സവ ഓഫറുകൾ', 'ഉത്സവ\nഓഫർ'),
      eid: P('ഈദ് മുബാറക്', 'ഈദ് ആശംസകൾ', 'ഏവർക്കും ഹൃദയം നിറഞ്ഞ ഈദ് ആശംസകൾ.', 'ഈദ് കളക്ഷൻ', 'ഈദ്\nസെയിൽ'),
      birthday: P('ജന്മദിനാശംസകൾ', 'ആഘോഷം', 'സ്നേഹവും ചിരിയും നിറഞ്ഞ ഒരു ദിനം ആശംസിക്കുന്നു.', 'പാർട്ടിക്ക് വരൂ', 'ആശംസ'),
      wedding: P('വിവാഹ ക്ഷണം', 'സേവ് ദ ഡേറ്റ്', 'ഞങ്ങളുടെ വിവാഹത്തിലേക്ക് സ്നേഹപൂർവ്വം ക്ഷണിക്കുന്നു', 'ക്ഷണിക്കുന്നു', 'വിവാഹം', { kicker: 'കുടുംബങ്ങളുടെ സ്നേഹപൂർവ്വമായ ക്ഷണം', names: 'ആയിഷ  &  രാഹുൽ', line1: '2026 ഡിസംബർ 12, ശനി  •  രാവിലെ 11:00', line2: 'റോയൽ ഗാർഡൻ ഓഡിറ്റോറിയം', line3: 'വിളിക്കുക: 98765 43210' }),
      food: P('രുചിയുടെ ഉത്സവം', 'ഫ്രഷ് & ഹോട്ട്', 'സ്നേഹത്തോടെ തയ്യാറാക്കിയ രുചികരമായ ഭക്ഷണം.', 'ഇപ്പോൾ ഓർഡർ ചെയ്യൂ', 'ഹോം\nഡെലിവറി'),
      jewellery: P('സ്വർണ്ണാഭരണ ശേഖരം', 'പുതിയ കളക്ഷൻ', 'എല്ലാ ആഘോഷങ്ങൾക്കും ഇണങ്ങുന്ന മനോഹര ഡിസൈനുകൾ.', 'ഷോറൂം സന്ദർശിക്കൂ', 'കുറഞ്ഞ\nപണിക്കൂലി'),
      education: P('അഡ്മിഷൻ ആരംഭിച്ചു', 'പുതിയ അധ്യയന വർഷം', 'മികച്ച അധ്യാപകരും ആധുനിക സൗകര്യങ്ങളും.', 'ഇന്ന് തന്നെ ചേരൂ', 'പരിമിത\nസീറ്റുകൾ'),
      realestate: P('സ്വപ്ന ഭവനം വിൽപ്പനയ്ക്ക്', 'പ്രീമിയം വില്ലകൾ', 'പ്രധാന സ്ഥലത്ത് വിശാലമായ 3 BHK വീടുകൾ.', 'സന്ദർശനം ബുക്ക് ചെയ്യൂ', 'റെഡി\nടു മൂവ്'),
      event: P('ലൈവ് പരിപാടി', 'നഷ്ടപ്പെടുത്തരുത്', 'സംഗീതം, ഭക്ഷണം, വിനോദം — കുടുംബത്തോടൊപ്പം ആസ്വദിക്കൂ.', 'ടിക്കറ്റ് എടുക്കൂ', 'പ്രവേശനം\nസൗജന്യം'),
      business: P('നിങ്ങളുടെ ബിസിനസ് വളർത്തൂ', 'സ്മാർട്ട് സൊല്യൂഷൻസ്', 'നിങ്ങളുടെ ബ്രാൻഡിനെ അടുത്ത തലത്തിലെത്തിക്കുന്ന സേവനങ്ങൾ.', 'ഇപ്പോൾ ബന്ധപ്പെടൂ', 'മികച്ച\nവില'),
      fashion: P('പുതിയ കളക്ഷൻ', 'ഫാഷൻ വീക്ക്', 'ഈ സീസണിലെ ഏറ്റവും പുതിയ ട്രെൻഡുകൾ കണ്ടെത്തൂ.', 'ഇപ്പോൾ കാണൂ', 'പുതിയത്'),
      opening: P('ഗ്രാൻഡ് ഉദ്ഘാടനം', 'നാളെ മുതൽ', 'ഉദ്ഘാടന ഓഫറുകൾ — എല്ലാവർക്കും സ്വാഗതം!', 'വരൂ, സ്വാഗതം', 'ഉദ്ഘാടന\nഓഫർ')
    },
    ta: {
      offer: P('மெகா ஆஃபர்', 'இன்று மட்டும்', 'அனைத்து பொருட்களுக்கும் அதிரடி தள்ளுபடி. உடனே வாருங்கள்!', 'இப்போதே வாங்குங்கள்', '50%\nதள்ளுபடி'),
      sale: P('பெரிய விற்பனை', 'சீசன் முடிவு', '70% வரை தள்ளுபடி. இந்த வாய்ப்பை தவறவிடாதீர்கள்!', 'இப்போதே வாங்குங்கள்', '70% வரை'),
      festival: P('பண்டிகை வாழ்த்துகள்', 'வாழ்த்துகள்', 'மகிழ்ச்சியும் செழிப்பும் நிறைந்த பண்டிகை காலம் அமையட்டும்.', 'பண்டிகை சலுகைகள்', 'பண்டிகை\nசலுகை'),
      eid: P('ஈத் முபாரக்', 'ஈத் வாழ்த்துகள்', 'அனைவருக்கும் இனிய ஈத் நல்வாழ்த்துகள்.', 'ஈத் கலெக்ஷன்', 'ஈத்\nசலுகை'),
      birthday: P('பிறந்தநாள் வாழ்த்துகள்', 'கொண்டாட்டம்', 'அன்பும் சிரிப்பும் நிறைந்த நாளாக அமையட்டும்.', 'விழாவுக்கு வாருங்கள்', 'வாழ்த்து'),
      wedding: P('திருமண அழைப்பிதழ்', 'தேதி குறித்துக்கொள்ளுங்கள்', 'எங்கள் திருமணத்திற்கு அன்புடன் அழைக்கிறோம்', 'அழைக்கிறோம்', 'திருமணம்', { kicker: 'குடும்பத்தினரின் அன்பான அழைப்பு', names: 'ஆயிஷா  &  ராகுல்', line1: '12 டிசம்பர் 2026, சனி  •  காலை 11:00', line2: 'ராயல் கார்டன் மண்டபம்', line3: 'தொடர்புக்கு: 98765 43210' }),
      food: P('சுவையின் திருவிழா', 'சூடான & புதிய', 'அன்புடன் தயாரிக்கப்பட்ட சுவையான உணவு.', 'இப்போதே ஆர்டர் செய்யுங்கள்', 'வீட்டு\nடெலிவரி'),
      jewellery: P('தங்க நகை சேகரிப்பு', 'புதிய வடிவமைப்புகள்', 'ஒவ்வொரு விழாவிற்கும் ஏற்ற அழகிய நகைகள்.', 'கடைக்கு வாருங்கள்', 'குறைந்த\nசெய்கூலி'),
      education: P('சேர்க்கை தொடங்கியது', 'புதிய கல்வியாண்டு', 'சிறந்த ஆசிரியர்கள், நவீன வசதிகள்.', 'இன்றே சேருங்கள்', 'குறைந்த\nஇடங்கள்'),
      realestate: P('கனவு இல்லம் விற்பனைக்கு', 'பிரீமியம் வில்லாக்கள்', 'முக்கிய இடத்தில் விசாலமான 3 BHK வீடுகள்.', 'பார்வையிட பதிவு செய்யுங்கள்', 'உடனே\nகுடியேறலாம்'),
      event: P('நேரலை நிகழ்ச்சி', 'தவறவிடாதீர்கள்', 'இசை, உணவு, பொழுதுபோக்கு — குடும்பத்துடன் மகிழுங்கள்.', 'டிக்கெட் பெறுங்கள்', 'அனுமதி\nஇலவசம்'),
      business: P('உங்கள் தொழிலை வளர்த்திடுங்கள்', 'ஸ்மார்ட் தீர்வுகள்', 'உங்கள் பிராண்டை அடுத்த நிலைக்கு உயர்த்தும் சேவைகள்.', 'இப்போதே தொடர்பு கொள்ளுங்கள்', 'சிறந்த\nவிலை'),
      fashion: P('புதிய கலெக்ஷன்', 'ஃபேஷன் வாரம்', 'இந்த சீசனின் புதிய டிரெண்டுகளைக் கண்டறியுங்கள்.', 'இப்போதே பாருங்கள்', 'புதியது'),
      opening: P('மாபெரும் திறப்பு விழா', 'நாளை முதல்', 'திறப்பு விழா சலுகைகள் — அனைவரும் வருக!', 'வருக வருக', 'திறப்பு\nசலுகை')
    },
    kn: {
      offer: P('ಮೆಗಾ ಆಫರ್', 'ಇಂದು ಮಾತ್ರ', 'ಎಲ್ಲಾ ವಸ್ತುಗಳ ಮೇಲೆ ಭಾರಿ ರಿಯಾಯಿತಿ. ಬೇಗ ಬನ್ನಿ!', 'ಈಗಲೇ ಖರೀದಿಸಿ', '50%\nರಿಯಾಯಿತಿ'),
      sale: P('ಬಿಗ್ ಸೇಲ್', 'ಸೀಸನ್ ಕೊನೆ', '70% ವರೆಗೆ ರಿಯಾಯಿತಿ. ಈ ಅವಕಾಶ ತಪ್ಪಿಸಿಕೊಳ್ಳಬೇಡಿ!', 'ಈಗಲೇ ಖರೀದಿಸಿ', '70% ವರೆಗೆ'),
      festival: P('ಹಬ್ಬದ ಶುಭಾಶಯಗಳು', 'ಶುಭಾಶಯಗಳು', 'ಸಂತೋಷ ಮತ್ತು ಸಮೃದ್ಧಿ ತುಂಬಿದ ಹಬ್ಬ ನಿಮ್ಮದಾಗಲಿ.', 'ಹಬ್ಬದ ಆಫರ್‌ಗಳು', 'ಹಬ್ಬದ\nಆಫರ್'),
      eid: P('ಈದ್ ಮುಬಾರಕ್', 'ಈದ್ ಶುಭಾಶಯಗಳು', 'ಎಲ್ಲರಿಗೂ ಹೃದಯಪೂರ್ವಕ ಈದ್ ಶುಭಾಶಯಗಳು.', 'ಈದ್ ಕಲೆಕ್ಷನ್', 'ಈದ್\nಆಫರ್'),
      birthday: P('ಜನ್ಮದಿನದ ಶುಭಾಶಯಗಳು', 'ಸಂಭ್ರಮ', 'ಪ್ರೀತಿ ಮತ್ತು ನಗು ತುಂಬಿದ ದಿನ ನಿಮ್ಮದಾಗಲಿ.', 'ಪಾರ್ಟಿಗೆ ಬನ್ನಿ', 'ಶುಭಾಶಯ'),
      wedding: P('ವಿವಾಹ ಆಹ್ವಾನ', 'ದಿನಾಂಕ ಗುರುತಿಸಿ', 'ನಮ್ಮ ವಿವಾಹಕ್ಕೆ ಪ್ರೀತಿಯಿಂದ ಆಹ್ವಾನಿಸುತ್ತೇವೆ', 'ಆಹ್ವಾನ', 'ವಿವಾಹ', { kicker: 'ಕುಟುಂಬದವರ ಪ್ರೀತಿಯ ಆಹ್ವಾನ', names: 'ಆಯಿಷಾ  &  ರಾಹುಲ್', line1: '12 ಡಿಸೆಂಬರ್ 2026, ಶನಿವಾರ  •  ಬೆಳಿಗ್ಗೆ 11:00', line2: 'ರಾಯಲ್ ಗಾರ್ಡನ್ ಸಭಾಂಗಣ', line3: 'ಸಂಪರ್ಕಿಸಿ: 98765 43210' }),
      food: P('ರುಚಿಯ ಹಬ್ಬ', 'ಬಿಸಿ & ತಾಜಾ', 'ಪ್ರೀತಿಯಿಂದ ತಯಾರಿಸಿದ ರುಚಿಕರ ಊಟ.', 'ಈಗಲೇ ಆರ್ಡರ್ ಮಾಡಿ', 'ಹೋಮ್\nಡೆಲಿವರಿ'),
      jewellery: P('ಚಿನ್ನಾಭರಣ ಸಂಗ್ರಹ', 'ಹೊಸ ಕಲೆಕ್ಷನ್', 'ಪ್ರತಿ ಸಂಭ್ರಮಕ್ಕೂ ಹೊಂದುವ ಸುಂದರ ವಿನ್ಯಾಸಗಳು.', 'ಶೋರೂಂಗೆ ಬನ್ನಿ', 'ಕಡಿಮೆ\nಮೇಕಿಂಗ್'),
      education: P('ಪ್ರವೇಶ ಆರಂಭ', 'ಹೊಸ ಶೈಕ್ಷಣಿಕ ವರ್ಷ', 'ಅನುಭವಿ ಶಿಕ್ಷಕರು ಮತ್ತು ಆಧುನಿಕ ಸೌಲಭ್ಯಗಳು.', 'ಇಂದೇ ಸೇರಿ', 'ಸೀಮಿತ\nಸೀಟುಗಳು'),
      realestate: P('ಕನಸಿನ ಮನೆ ಮಾರಾಟಕ್ಕೆ', 'ಪ್ರೀಮಿಯಂ ವಿಲ್ಲಾಗಳು', 'ಪ್ರಮುಖ ಸ್ಥಳದಲ್ಲಿ ವಿಶಾಲವಾದ 3 BHK ಮನೆಗಳು.', 'ಭೇಟಿಗೆ ಬುಕ್ ಮಾಡಿ', 'ತಕ್ಷಣ\nವಾಸಕ್ಕೆ'),
      event: P('ಲೈವ್ ಕಾರ್ಯಕ್ರಮ', 'ತಪ್ಪಿಸಿಕೊಳ್ಳಬೇಡಿ', 'ಸಂಗೀತ, ಊಟ, ಮನರಂಜನೆ — ಕುಟುಂಬದೊಂದಿಗೆ ಆನಂದಿಸಿ.', 'ಟಿಕೆಟ್ ಪಡೆಯಿರಿ', 'ಪ್ರವೇಶ\nಉಚಿತ'),
      business: P('ನಿಮ್ಮ ವ್ಯಾಪಾರ ಬೆಳೆಸಿ', 'ಸ್ಮಾರ್ಟ್ ಪರಿಹಾರಗಳು', 'ನಿಮ್ಮ ಬ್ರಾಂಡ್ ಅನ್ನು ಮುಂದಿನ ಹಂತಕ್ಕೆ ಕೊಂಡೊಯ್ಯುವ ಸೇವೆಗಳು.', 'ಈಗಲೇ ಸಂಪರ್ಕಿಸಿ', 'ಉತ್ತಮ\nಬೆಲೆ'),
      fashion: P('ಹೊಸ ಕಲೆಕ್ಷನ್', 'ಫ್ಯಾಷನ್ ವೀಕ್', 'ಈ ಸೀಸನ್‌ನ ಹೊಸ ಟ್ರೆಂಡ್‌ಗಳನ್ನು ಅನ್ವೇಷಿಸಿ.', 'ಈಗಲೇ ನೋಡಿ', 'ಹೊಸದು'),
      opening: P('ಭವ್ಯ ಉದ್ಘಾಟನೆ', 'ನಾಳೆಯಿಂದ', 'ಉದ್ಘಾಟನಾ ಆಫರ್‌ಗಳು — ಎಲ್ಲರಿಗೂ ಸ್ವಾಗತ!', 'ಬನ್ನಿ, ಸ್ವಾಗತ', 'ಉದ್ಘಾಟನಾ\nಆಫರ್')
    },
    hi: {
      offer: P('मेगा ऑफर', 'सिर्फ आज', 'सभी सामान पर भारी छूट। जल्दी आइए!', 'अभी खरीदें', '50%\nछूट'),
      sale: P('बड़ी सेल', 'सीज़न एंड', '70% तक की छूट। यह मौका न चूकें!', 'अभी खरीदें', '70% तक'),
      festival: P('त्योहार की शुभकामनाएँ', 'शुभकामनाएँ', 'खुशियों और समृद्धि से भरा त्योहार आपको मुबारक हो।', 'त्योहार ऑफर', 'त्योहार\nऑफर'),
      eid: P('ईद मुबारक', 'ईद की शुभकामनाएँ', 'आप सभी को ईद की दिली मुबारकबाद।', 'ईद कलेक्शन', 'ईद\nसेल'),
      birthday: P('जन्मदिन की शुभकामनाएँ', 'जश्न', 'प्यार और हँसी से भरा दिन आपको मुबारक हो।', 'पार्टी में आइए', 'बधाई'),
      wedding: P('विवाह निमंत्रण', 'तारीख याद रखें', 'हमारे विवाह में आपका हार्दिक स्वागत है', 'निमंत्रण', 'विवाह', { kicker: 'दोनों परिवारों की ओर से निमंत्रण', names: 'आयशा  &  राहुल', line1: '12 दिसंबर 2026, शनिवार  •  सुबह 11:00', line2: 'रॉयल गार्डन ऑडिटोरियम', line3: 'संपर्क: 98765 43210' }),
      food: P('स्वाद का त्योहार', 'ताज़ा और गरम', 'प्यार से बना स्वादिष्ट खाना।', 'अभी ऑर्डर करें', 'होम\nडिलीवरी'),
      jewellery: P('स्वर्ण आभूषण संग्रह', 'नया कलेक्शन', 'हर उत्सव के लिए खूबसूरत डिज़ाइन।', 'शोरूम पधारें', 'कम\nमेकिंग'),
      education: P('प्रवेश प्रारंभ', 'नया शैक्षणिक सत्र', 'अनुभवी शिक्षक और आधुनिक सुविधाएँ।', 'आज ही जुड़ें', 'सीमित\nसीटें'),
      realestate: P('सपनों का घर बिकाऊ', 'प्रीमियम विला', 'प्रमुख स्थान पर विशाल 3 BHK घर।', 'साइट विज़िट बुक करें', 'तैयार\nघर'),
      event: P('लाइव कार्यक्रम', 'चूकिएगा नहीं', 'संगीत, खाना, मनोरंजन — परिवार के साथ आनंद लें।', 'टिकट लें', 'प्रवेश\nमुफ़्त'),
      business: P('अपना बिज़नेस बढ़ाएँ', 'स्मार्ट समाधान', 'आपके ब्रांड को अगले स्तर तक ले जाने वाली सेवाएँ।', 'आज ही संपर्क करें', 'बेस्ट\nप्राइस'),
      fashion: P('नया कलेक्शन', 'फ़ैशन वीक', 'इस सीज़न के लेटेस्ट ट्रेंड्स देखें।', 'अभी देखें', 'नया'),
      opening: P('भव्य उद्घाटन', 'कल से', 'उद्घाटन ऑफर — सभी का स्वागत है!', 'पधारिए', 'उद्घाटन\nऑफर')
    }
  };
  const CAT_META = { // id: [English label, motifs, [layout, palette, opts?] x3]
    offer: ['Offer Posters', ['🔥', '🎁', '💥'], [['burst', 'fire'], ['diag', 'royal'], ['stripe', 'sun']]],
    sale: ['Sale Posters', ['🛍️', '⚡', '🎯'], [['diag', 'navy'], ['stripe', 'fire'], ['neon', 'night']]],
    festival: ['Festival Posters', ['🪔', '🎆', '✨'], [['frame', 'sun'], ['burst', 'royal'], ['split', 'emerald']]],
    eid: ['Eid Posters', ['🌙', '🕌', '⭐'], [['frame', 'emerald'], ['invite', 'gold', { dark: true }], ['neon', 'teal']]],
    birthday: ['Birthday Posters', ['🎂', '🎈', '🎉'], [['burst', 'berry'], ['stripe', 'rose'], ['frame', 'ocean']]],
    wedding: ['Wedding Invitations', ['💍', '💐', '✨'], [['invite', 'cream', { script: true }], ['invite', 'gold', { dark: true, script: true }], ['frame', 'rose']]],
    food: ['Food Posters', ['🍛', '🍔', '🍕'], [['photo', 'sun'], ['diag', 'fire'], ['stripe', 'forest']]],
    jewellery: ['Jewellery Posters', ['💍', '💎', '👑'], [['invite', 'gold', { dark: true }], ['frame', 'royal'], ['neon', 'gold']]],
    education: ['Education Posters', ['🎓', '📚', '✏️'], [['split', 'ocean'], ['stripe', 'navy'], ['minimal', 'forest']]],
    realestate: ['Real Estate Posters', ['🏠', '🔑', '🏡'], [['photo', 'navy'], ['diag', 'forest'], ['minimal', 'teal']]],
    event: ['Event Posters', ['🎤', '🎶', '🎉'], [['neon', 'royal'], ['burst', 'night'], ['diag', 'berry']]],
    business: ['Business Posters', ['💼', '📈', '🤝'], [['minimal', 'teal'], ['split', 'navy'], ['stripe', 'night']]],
    fashion: ['Fashion Posters', ['👗', '👠', '👜'], [['minimal', 'rose'], ['frame', 'berry'], ['diag', 'night']]],
    opening: ['Grand Opening', ['🎊', '🎀', '✨'], [['burst', 'royal'], ['stripe', 'fire'], ['frame', 'teal']]]
  };
  const V2_SIZES = ['port', 'post', 'port'];
  let v2n = 0;
  Object.keys(LANGS).forEach(lang => Object.keys(CAT_META).forEach(cat => {
    const [catLabel, motif, sets] = CAT_META[cat], pk = PACKS[lang][cat];
    sets.forEach((v, vi) => {
      templates.push({ id: `${cat}-${lang}-${vi + 1}`, cat, catLabel: `${catLabel} · ${LANGS[lang]}`, lang, tags: LANG_TAGS[lang] + ' ' + cat, name: `${pk.head.replace(/\n/g, ' ')} ${vi + 1}`, size: V2_SIZES[vi], layout: v[0], pal: v[1], opts: v[2] || {}, motif, head: pk.head, tag: pk.tag, sub: pk.sub, cta: pk.cta, badge: pk.badge, invite: pk.inv, foot: '📞 98765 43210   📍 ' + LFOOT[lang], premium: (v2n++) % 4 === 3 });
    });
  }));

  function build(t, W, H) {
    W = W || SZ[t.size][0]; H = H || SZ[t.size][1];
    const p = Object.assign({}, PAL[t.pal], { headFont: t.headFont, bgKey: t.pal });
    const lf = t.lang && t.lang !== 'en' && LF[t.lang], saved = Object.assign({}, FONT);
    if (lf) Object.keys(FONT).forEach(k => { FONT[k] = lf; }); // all text of non-English templates uses the language's own font
    try { return L[t.layout](W, H, t, p, t.opts); } finally { Object.assign(FONT, saved); }
  }
  const sampleOf = t => [t.head, t.tag, t.sub, t.cta, t.badge, t.foot].join(' ');
  function fontsFor(t) { const s = [FONT.body, FONT.anton, FONT.serif]; if (t.headFont) s.push(t.headFont); if (t.lang && LF[t.lang]) s.push(LF[t.lang]); else if (/[\u0D00-\u0D7F]/.test(t.head + t.sub)) s.push(FONT.ml); return s; }

  // ------------------------------------------------------------------ UI state
  let query = '', catFilter = 'all', accessFilter = 'all', langFilter = 'all', favs = [], extra = [];
  try { favs = JSON.parse(localStorage.getItem('studio_fav_tpl') || '[]'); } catch (e) { favs = []; }
  const thumbCache = {};
  const all = () => templates.concat(extra);
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : s);
  function isLocked(t) { return !!t.premium && window.STATE && STATE.profile && STATE.profile.plan === 'free'; }

  async function thumbFor(t) {
    if (thumbCache[t.id]) return thumbCache[t.id];
    if (t.thumb) return t.thumb; // admin templates carry their own preview
    const W = SZ[t.size][0], H = SZ[t.size][1], s = 220 / Math.max(W, H);
    await A().ensureFonts(fontsFor(t), sampleOf(t));
    const spec = build(t, W, H), sc = new F.StaticCanvas(null, { width: Math.round(W * s), height: Math.round(H * s) });
    sc.setZoom(s); sc.backgroundColor = StudioLib.makeFill(spec.bg, W, H); spec.objs.forEach(o => sc.add(o)); sc.renderAll();
    const url = sc.toDataURL({ format: 'jpeg', quality: 0.8 }); sc.dispose && sc.dispose(); thumbCache[t.id] = url; return url;
  }
  function visible() {
    const q = query.trim().toLowerCase();
    return all().filter(t => (catFilter === 'all' || (catFilter === 'fav' ? favs.includes(t.id) : t.cat === catFilter)) &&
      (accessFilter === 'all' || (accessFilter === 'free') === !t.premium) && (langFilter === 'all' || (t.lang || 'en') === langFilter) &&
      (!q || (t.name + ' ' + t.catLabel + ' ' + (t.head || '') + ' ' + (t.tags || '')).toLowerCase().includes(q)));
  }
  function render(body) {
    const cats = CATS.map(c => [c[0], c[1]]);
    Object.keys(CAT_META).forEach(id => { if (!cats.find(c => c[0] === id)) cats.push([id, CAT_META[id][0]]); });
    const extraCats = Array.from(new Set(extra.map(t => t.cat).filter(x => !cats.find(c => c[0] === x)))).map(x => [x, x]);
    body.innerHTML = `
      <input class="studio-search" type="search" placeholder="Search templates (offer, wedding, Eid, food…)" value="${esc(query)}" oninput="StudioTpl.setQuery(this.value)">
      <div class="studio-chiprow">
        <button class="studio-chip ${catFilter === 'all' ? 'active' : ''}" onclick="StudioTpl.setCat('all')">All</button>
        <button class="studio-chip ${catFilter === 'fav' ? 'active' : ''}" onclick="StudioTpl.setCat('fav')">♥ Favourites</button>
        ${cats.concat(extraCats).map(([id, l]) => `<button class="studio-chip ${catFilter === id ? 'active' : ''}" onclick="StudioTpl.setCat('${id}')">${esc(l)}</button>`).join('')}
      </div>
      <div class="studio-chiprow">${[['all', 'All languages']].concat(Object.entries(LANGS)).map(([k, l]) => `<button class="studio-chip ${langFilter === k ? 'active' : ''}" onclick="StudioTpl.setLang('${k}')">${l}</button>`).join('')}</div>
      <div class="studio-chiprow">${[['all', 'Free + Premium'], ['free', 'Free'], ['premium', 'Premium']].map(([k, l]) => `<button class="studio-chip ${accessFilter === k ? 'active' : ''}" onclick="StudioTpl.setAccess('${k}')">${l}</button>`).join('')}</div>
      <div class="studio-tpl-grid" id="studioTplGrid"></div>`;
    paintGrid();
  }
  async function paintGrid() {
    const grid = document.getElementById('studioTplGrid'); if (!grid) return;
    const list = visible();
    if (!list.length) { grid.innerHTML = '<p class="studio-empty-hint">No templates match. Try another search or category.</p>'; return; }
    grid.innerHTML = list.map(t => {
      const locked = isLocked(t), fav = favs.includes(t.id);
      return `<div class="studio-tpl" data-id="${t.id}">
        <button class="studio-tpl-fav ${fav ? 'on' : ''}" onclick="StudioTpl.toggleFav('${t.id}')" title="Favourite">${fav ? '♥' : '♡'}</button>
        ${t.premium ? `<span class="studio-tpl-badge">${locked ? '🔒 ' : ''}PRO</span>` : ''}
        <div class="studio-tpl-img" onclick="StudioTpl.use('${t.id}')"><img alt="${esc(t.name)}" ${thumbCache[t.id] || t.thumb ? `src="${thumbCache[t.id] || t.thumb}"` : ''}></div>
        <div class="studio-tpl-name">${esc(t.name)}<small>${esc(t.catLabel)}</small></div>
        <div class="studio-tpl-actions"><button onclick="StudioTpl.preview('${t.id}')">Preview</button><button class="primary" onclick="StudioTpl.use('${t.id}')">${locked ? 'Unlock' : 'Use'}</button></div>
      </div>`;
    }).join('');
    // render previews progressively so the drawer stays responsive
    for (const t of list) {
      const el = grid.querySelector(`[data-id="${t.id}"] img`); if (!el || el.getAttribute('src')) continue;
      try { el.src = await thumbFor(t); } catch (e) { console.warn('thumb failed', t.id, e); }
      await new Promise(r => setTimeout(r, 0));
      if (!document.getElementById('studioTplGrid')) return;
    }
  }
  function setQuery(v) { query = v; clearTimeout(setQuery.t); setQuery.t = setTimeout(paintGrid, 180); }
  function setCat(c) { catFilter = c; render(document.getElementById('studioDrawerBody')); }
  function setLang(l) { langFilter = l; render(document.getElementById('studioDrawerBody')); }
  function setAccess(a) { accessFilter = a; render(document.getElementById('studioDrawerBody')); }
  function toggleFav(id) {
    favs = favs.includes(id) ? favs.filter(x => x !== id) : favs.concat(id);
    try { localStorage.setItem('studio_fav_tpl', JSON.stringify(favs)); } catch (e) { /* ignore */ }
    if (window.StudioStore) StudioStore.syncFavs(favs);
    paintGrid();
  }
  async function use(id) {
    const t = all().find(x => x.id === id); if (!t) return;
    if (isLocked(t)) { toast('This is a premium template — upgrade to unlock', true); Studio.api.flushSave(); if (window.goto) goto('payment'); return; }
    await useTemplate(t);
  }
  async function useTemplate(t, sizeOverride) {
    if (t.doc) { // admin template saved as a full document
      Studio.api.loadDoc(Object.assign({}, t.doc, { id: null, name: t.name })); Studio.closeDrawer(); toast('Template loaded — everything is editable'); return;
    }
    const W = sizeOverride ? sizeOverride[0] : SZ[t.size][0], H = sizeOverride ? sizeOverride[1] : SZ[t.size][1];
    await A().ensureFonts(fontsFor(t), sampleOf(t));
    Studio.api.flushSave();
    Studio.api.loadBuilt({ name: t.name, width: W, height: H, kind: 'design', pages: [build(t, W, H)] });
    Studio.closeDrawer(); toast('Template loaded — everything is editable');
  }
  async function preview(id) {
    const t = all().find(x => x.id === id); if (!t) return;
    const url = await thumbFor(t), m = document.getElementById('studioPreviewModal');
    m.querySelector('img').src = url; m.querySelector('.name').textContent = t.name; m.dataset.id = id; m.classList.add('show');
  }
  function closePreview() { document.getElementById('studioPreviewModal').classList.remove('show'); }
  function usePreview() { const id = document.getElementById('studioPreviewModal').dataset.id; closePreview(); use(id); }
  function addExtra(list) { extra = list || []; }
  function bySize(sizeKey) { return templates.filter(t => t.size === sizeKey); }

  Studio.registerTab({ id: 'templates', label: 'Templates', icon: '▣', order: 10, render });

  return { PACKS, LANGS, LF, CAT_META, templates, CATS, SZ, build, fontsFor, setQuery, setCat, setLang, setAccess, toggleFav, use, useTemplate, preview, closePreview, usePreview, addExtra, bySize, thumbFor, FONT, PAL, L, favs: () => favs, all };
})();


// ======================= studio-tools.js =======================
// ===================================================================================
// DESIGN STUDIO — makers: Logo Maker, Business Card Maker, Social Media Studio,
// Print documents (flyer / invitation / menu / brochure / catalogue, multi-page) and the
// size-preset library. Everything is generated from real Fabric objects so the result is
// fully editable in the studio afterwards. No AI — pure layout code driven by a form.
// ===================================================================================
var StudioTools = (() => {
  const F = fabric, A = () => Studio.api;
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const EMOJI = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  const BODY = "'Manrope',sans-serif", SERIF = "'Fraunces',serif", ANTON = "'Anton',sans-serif";

  // ------------------------------------------------------------------ size presets
  const PRESETS = [
    { g: 'Social', id: 'ig-post', label: 'Instagram Post (1080×1080)', w: 1080, h: 1080 },
    { g: 'Social', id: 'ig-port', label: 'Instagram Portrait (1080×1350)', w: 1080, h: 1350 },
    { g: 'Social', id: 'ig-story', label: 'Instagram Story / Reel (1080×1920)', w: 1080, h: 1920 },
    { g: 'Social', id: 'fb-post', label: 'Facebook Post (1200×630)', w: 1200, h: 630 },
    { g: 'Social', id: 'fb-cover', label: 'Facebook Cover (1640×624)', w: 1640, h: 624 },
    { g: 'Social', id: 'fb-event', label: 'Facebook Event (1920×1005)', w: 1920, h: 1005 },
    { g: 'Social', id: 'yt-thumb', label: 'YouTube Thumbnail (1280×720)', w: 1280, h: 720 },
    { g: 'Social', id: 'yt-art', label: 'YouTube Channel Art (2560×1440)', w: 2560, h: 1440 },
    { g: 'Social', id: 'wa-status', label: 'WhatsApp Status (1080×1920)', w: 1080, h: 1920 },
    { g: 'Social', id: 'wa-post', label: 'WhatsApp Post (1080×1080)', w: 1080, h: 1080 },
    { g: 'Social', id: 'li-banner', label: 'LinkedIn Banner (1584×396)', w: 1584, h: 396 },
    { g: 'Social', id: 'x-post', label: 'X / Twitter Post (1600×900)', w: 1600, h: 900 },
    { g: 'Social', id: 'pin', label: 'Pinterest Pin (1000×1500)', w: 1000, h: 1500 },
    { g: 'Print', id: 'a4', label: 'A4 Portrait (210×297 mm)', w: 1240, h: 1754, mm: { w: 210, h: 297 } },
    { g: 'Print', id: 'a4l', label: 'A4 Landscape (297×210 mm)', w: 1754, h: 1240, mm: { w: 297, h: 210 } },
    { g: 'Print', id: 'a3', label: 'A3 Poster (297×420 mm)', w: 1754, h: 2480, mm: { w: 297, h: 420 } },
    { g: 'Print', id: 'a5', label: 'A5 (148×210 mm)', w: 874, h: 1240, mm: { w: 148, h: 210 } },
    { g: 'Print', id: 'card', label: 'Business Card (88.9×50.8 mm)', w: 1050, h: 600, mm: { w: 88.9, h: 50.8 } },
    { g: 'Print', id: 'vcard', label: 'Visiting Card Vertical (50.8×88.9 mm)', w: 600, h: 1050, mm: { w: 50.8, h: 88.9 } },
    { g: 'Print', id: 'invite', label: 'Invitation 5×7 in (127×178 mm)', w: 750, h: 1050, mm: { w: 127, h: 178 } },
    { g: 'Web', id: 'web-banner', label: 'Website Banner (1920×600)', w: 1920, h: 600 },
    { g: 'Web', id: 'ad-leader', label: 'Ad Leaderboard (1940×500)', w: 1940, h: 500 },
    { g: 'Web', id: 'ad-rect', label: 'Ad Rectangle (1200×1000)', w: 1200, h: 1000 },
    { g: 'Other', id: 'logo', label: 'Logo (1000×1000)', w: 1000, h: 1000 }
  ];
  const preset = id => PRESETS.find(p => p.id === id);

  // ------------------------------------------------------------------ dialog helpers
  function dlg(title, html) {
    const card = document.getElementById('studioDialogCard');
    card.innerHTML = `<div style="display:flex;align-items:center;margin-bottom:10px"><h3 style="margin:0;flex:1">${title}</h3><button class="icon-btn" onclick="StudioTools.closeDlg()">✕</button></div>${html}`;
    document.getElementById('studioDialog').classList.add('show'); card.scrollTop = 0;
  }
  const closeDlg = () => document.getElementById('studioDialog').classList.remove('show');
  const $v = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  function fields(list, prefix) {
    return list.map(f => {
      const id = `${prefix}_${f.k}`;
      if (f.t === 'color') return `<label class="studio-label">${f.l}</label><input type="color" id="${id}" value="${f.d}" oninput="${f.on || ''}">`;
      if (f.t === 'select') return `<label class="studio-label">${f.l}</label><select id="${id}" onchange="${f.on || ''}">${f.o.map(o => `<option value="${esc(o[0])}" ${o[0] === f.d ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
      if (f.t === 'area') return `<label class="studio-label">${f.l}</label><textarea id="${id}" rows="${f.r || 4}" oninput="${f.on || ''}">${esc(f.d || '')}</textarea>`;
      return `<label class="studio-label">${f.l}</label><input type="text" id="${id}" value="${esc(f.d || '')}" placeholder="${esc(f.p || '')}" oninput="${f.on || ''}">`;
    }).join('');
  }
  const collect = (list, prefix) => Object.fromEntries(list.map(f => [f.k, $v(`${prefix}_${f.k}`)]));
  const isDark = hex => { const c = StudioLib.hexToRgb(hex); return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) < 140; };
  const tint = (hex, a) => StudioLib.rgba(hex, a);

  // ------------------------------------------------------------------ text helpers
  const measureCache = {};
  function width100(text, css, weight) {
    const key = css + '|' + weight + '|' + text; if (measureCache[key]) return measureCache[key];
    let w; try { w = new F.Text(text, { fontFamily: css, fontSize: 100, fontWeight: weight || 'normal' }).width; } catch (e) { w = text.length * 58; }
    if (!w || !isFinite(w)) w = text.length * 58; return (measureCache[key] = w);
  }
  const fitSize = (text, css, maxW, base, weight) => Math.max(10, Math.min(base, Math.floor(100 * maxW / width100(text, css, weight))));
  function T(text, o) {
    const opts = Object.assign({ fontFamily: BODY, fontSize: 40, fill: '#111', originX: 'center', originY: 'center', studioKind: 'text' }, o);
    return new F.Text(text, opts);
  }
  function TB(text, o) { // wrapping box, top-anchored
    return new F.Textbox(text, Object.assign({ fontFamily: BODY, fontSize: 30, fill: '#111', originX: 'left', originY: 'top', textAlign: 'left', studioKind: 'text', lineHeight: 1.25 }, o));
  }
  const R = (x, y, w, h, o) => new F.Rect(Object.assign({ left: x, top: y, width: w, height: h, originX: 'center', originY: 'center' }, o));
  const C = (x, y, r, o) => new F.Circle(Object.assign({ left: x, top: y, radius: r, originX: 'center', originY: 'center' }, o));
  function SH(id, x, y, size, fill, o) {
    const p = StudioLib.makeShape(id, fill), s = size / Math.max(p.width, p.height);
    p.set(Object.assign({ left: x, top: y, scaleX: s, scaleY: s, originX: 'center', originY: 'center' }, o || {})); return p;
  }
  const E = (ch, x, y, size, o) => new F.Text(ch, Object.assign({ fontFamily: EMOJI, fontSize: size, left: x, top: y, originX: 'center', originY: 'center', studioKind: 'emoji' }, o));
  const fontCss = v => v || BODY;

  function openBuilt(name, W, H, pages, kind, mm) {
    Studio.api.flushSave();
    A().loadBuilt({ name, width: W, height: H, kind: kind || 'design', mm: mm || null, pages });
    closeDlg(); Studio.closeDrawer();
  }
  function thumbOf(spec, W, H, maxPx, bgForTransparent) {
    const s = maxPx / Math.max(W, H), sc = new F.StaticCanvas(null, { width: Math.round(W * s), height: Math.round(H * s) });
    sc.setZoom(s); sc.backgroundColor = StudioLib.makeFill(spec.bg, W, H) || bgForTransparent || '#ffffff';
    spec.objs.forEach(o => sc.add(o)); sc.renderAll();
    const u = sc.toDataURL({ format: 'png' }); sc.dispose && sc.dispose(); return u;
  }

  // ===================================================================================
  // LOGO MAKER
  // ===================================================================================
  const LOGO_ICONS = ['', '⭐', '🔥', '💎', '👑', '🌿', '🍃', '☕', '🍔', '🍕', '🛍️', '👗', '💄', '🏠', '🚗', '📚', '🎓', '💼', '📷', '🎵', '🕌', '🌙', '🪔', '💪', '🏥', '🧁', '🌸', '⚡', '🔧', '✂️', 'initial'];
  const LOGO_FIELDS = [
    { k: 'name', l: 'Brand name', d: 'Royal Bakers', on: 'StudioTools.logoRefresh()' },
    { k: 'tag', l: 'Tagline (optional)', d: 'FRESH EVERY DAY', on: 'StudioTools.logoRefresh()' },
    { k: 'c1', l: 'Main colour', t: 'color', d: '#0E6E5D', on: 'StudioTools.logoRefresh()' },
    { k: 'c2', l: 'Accent colour', t: 'color', d: '#CC9A3C', on: 'StudioTools.logoRefresh()' },
    { k: 'font', l: 'Font', t: 'select', d: ANTON, o: [], on: 'StudioTools.logoRefresh()' },
    { k: 'icon', l: 'Icon', t: 'select', d: '⭐', o: LOGO_ICONS.map(i => [i, i === '' ? 'None' : i === 'initial' ? 'Initial letter' : i]), on: 'StudioTools.logoRefresh()' }
  ];
  function logoVariants(v) {
    const W = 1000, H = 1000, cx = 500, c1 = v.c1, c2 = v.c2, f = fontCss(v.font), name = v.name || 'Your Brand', tag = (v.tag || '').trim();
    const init = (name.trim()[0] || 'A').toUpperCase();
    const icon = (x, y, size, onDark) => !v.icon ? null : v.icon === 'initial' ? T(init, { left: x, top: y, fontFamily: f, fontSize: size, fill: onDark ? '#fff' : c1, fontWeight: 'bold' }) : E(v.icon, x, y, size);
    const nameT = (x, y, maxW, base, fill, o) => T(name, Object.assign({ left: x, top: y, fontFamily: f, fontSize: fitSize(name, f, maxW, base), fill }, o));
    const tagT = (x, y, maxW, base, fill, o) => tag ? T(tag, Object.assign({ left: x, top: y, fontFamily: BODY, fontWeight: '800', fontSize: Math.min(base, fitSize(tag, BODY, maxW, base, '800') ), fill, charSpacing: 300 }, o)) : null;
    const pack = l => l.filter(Boolean);
    const words = name.split(/\s+/), w1 = words[0], w2 = words.slice(1).join(' ');
    return [
      // 1 stacked circle
      pack([C(cx, 340, 190, { fill: c1 }), icon(cx, 345, 200, true), nameT(cx, 650, 820, 150, c1), tagT(cx, 760, 700, 40, c2)]),
      // 2 horizontal
      pack([C(260, 500, 150, { fill: c1 }), icon(260, 505, 160, true), nameT(660, tag ? 470 : 500, 560, 120, c1), tagT(660, 570, 540, 36, c2)].map(o => o)),
      // 3 round badge
      pack([C(cx, cx, 440, { fill: c1, stroke: c2, strokeWidth: 20 }), C(cx, cx, 395, { fill: 'transparent', stroke: '#ffffff', strokeWidth: 4 }), icon(cx, 330, 190, true), nameT(cx, 560, 640, 130, '#ffffff'), tagT(cx, 690, 520, 36, c2)]),
      // 4 hexagon emblem
      pack([SH('hexagon', cx, 330, 400, c1), icon(cx, 335, 190, true), nameT(cx, 640, 820, 140, c1), tagT(cx, 745, 680, 38, c2)]),
      // 5 monogram square
      pack([new F.Rect({ left: cx, top: 330, originX: 'center', originY: 'center', width: 320, height: 320, rx: 60, ry: 60, fill: c1 }), T(init, { left: cx, top: 335, fontFamily: f, fontSize: 230, fill: c2, fontWeight: 'bold' }), nameT(cx, 620, 820, 130, c1), tagT(cx, 720, 700, 38, c2)]),
      // 6 underline bar
      pack([icon(cx, 300, 170, false), nameT(cx, 500, 880, 190, c1), R(cx, 620, 420, 14, { fill: c2 }), tagT(cx, 700, 760, 44, '#333')]),
      // 7 pill label
      (() => { const s = fitSize(name, f, 700, 120), pw = Math.min(900, width100(name, f) * s / 100 + 160); return pack([icon(cx, 300, 170, false), new F.Rect({ left: cx, top: 500, originX: 'center', originY: 'center', width: pw, height: s * 1.7, rx: s, ry: s, fill: c1 }), T(name, { left: cx, top: 500, fontFamily: f, fontSize: s, fill: '#fff' }), tagT(cx, 500 + s * 1.2 + 50, 720, 40, c2)]); })(),
      // 8 two-tone name
      pack([icon(cx, 290, 180, false), w2 ? T(w1 + ' ', { left: cx, top: 500, fontFamily: f, fontSize: 10, fill: c1, opacity: 0 }) : null,
      ...(w2 ? (() => { const s = fitSize(name, f, 860, 150), a = width100(w1, f) * s / 100, b = width100(w2, f) * s / 100, gap = s * 0.25, tot = a + gap + b, x0 = cx - tot / 2; return [T(w1, { left: x0 + a / 2, top: 500, fontFamily: f, fontSize: s, fill: c1 }), T(w2, { left: x0 + a + gap + b / 2, top: 500, fontFamily: f, fontSize: s, fill: c2 })]; })() : [nameT(cx, 500, 860, 150, c1)]), tagT(cx, 620, 760, 42, '#444')].filter(o => !(o && o.opacity === 0))),
      // 9 seal
      pack([SH('seal24', cx, 340, 420, c1), C(cx, 340, 140, { fill: '#fff' }), icon(cx, 345, 170, false), nameT(cx, 650, 820, 140, c1), tagT(cx, 750, 700, 38, c2)]),
      // 10 elegant lines
      pack([R(cx, 330, 700, 6, { fill: c2 }), nameT(cx, 480, 860, 160, c1, { fontFamily: f }), R(cx, 640, 700, 6, { fill: c2 }), tagT(cx, 720, 760, 42, '#444'), icon(cx, 200, 110, false)]),
      // 11 dark badge
      pack([new F.Rect({ left: cx, top: cx, originX: 'center', originY: 'center', width: 760, height: 760, rx: 90, ry: 90, fill: '#14110F', stroke: c2, strokeWidth: 10 }), icon(cx, 340, 200, true), nameT(cx, 590, 620, 120, c2), tagT(cx, 700, 560, 34, '#ffffff')]),
      // 12 minimal dot
      (() => { const s = fitSize(name, f, 800, 170), w = width100(name, f) * s / 100; return pack([T(name, { left: cx - 24, top: 480, fontFamily: f, fontSize: s, fill: c1 }), C(cx - 24 + w / 2 + s * 0.14, 480 + s * 0.3, s * 0.1, { fill: c2 }), tagT(cx, 480 + s * 0.8, 780, 42, '#444'), icon(cx, 270, 140, false)]); })()
    ];
  }
  function openLogo() {
    const fl = StudioLib.fontList(); LOGO_FIELDS.find(f => f.k === 'font').o = fl.map(x => [x.css, x.label]);
    dlg('Logo Maker', `<div class="studio-form">${fields(LOGO_FIELDS, 'lg')}
      <label class="studio-label">Pick a style (tap)</label><div class="studio-variants" id="studioLogoVars"></div>
      <p class="studio-hint">Every logo opens fully editable and exports as a transparent PNG.</p>
      <div class="studio-actions"><button class="btn btn-outline" onclick="StudioTools.openHub()">Back</button><button class="btn btn-primary" onclick="StudioTools.logoUse()">Use this logo</button></div></div>`);
    logoSel = 0; logoRefresh();
  }
  let logoSel = 0, logoTimer = null;
  function logoVals() { return collect(LOGO_FIELDS, 'lg'); }
  function logoRefresh() {
    clearTimeout(logoTimer);
    logoTimer = setTimeout(async () => {
      const v = logoVals(); await A().ensureFonts([fontCss(v.font)], v.name);
      const box = document.getElementById('studioLogoVars'); if (!box) return;
      const vars = logoVariants(v);
      box.innerHTML = vars.map((objs, i) => `<img data-i="${i}" class="${i === logoSel ? 'sel' : ''}" src="${thumbOf({ bg: '#ffffff', objs }, 1000, 1000, 200)}" onclick="StudioTools.logoPick(${i})">`).join('');
    }, 200);
  }
  function logoPick(i) { logoSel = i; document.querySelectorAll('#studioLogoVars img').forEach((im, j) => im.classList.toggle('sel', i === j)); }
  async function logoUse() {
    const v = logoVals(); await A().ensureFonts([fontCss(v.font)], v.name);
    openBuilt((v.name || 'Logo') + ' logo', 1000, 1000, [{ bg: '', objs: logoVariants(v)[logoSel] }], 'logo');
    toast('Logo created — export as transparent PNG from Export');
  }

  // ===================================================================================
  // BUSINESS CARD MAKER
  // ===================================================================================
  const CARD_FIELDS = [
    { k: 'name', l: 'Full name', d: 'Rahul Menon', on: 'StudioTools.cardRefresh()' },
    { k: 'title', l: 'Job title', d: 'Managing Director', on: 'StudioTools.cardRefresh()' },
    { k: 'company', l: 'Company', d: 'Royal Traders', on: 'StudioTools.cardRefresh()' },
    { k: 'tag', l: 'Tagline (optional)', d: 'Quality you can trust', on: 'StudioTools.cardRefresh()' },
    { k: 'phone', l: 'Phone', d: '+91 98765 43210', on: 'StudioTools.cardRefresh()' },
    { k: 'email', l: 'Email', d: 'rahul@royaltraders.in', on: 'StudioTools.cardRefresh()' },
    { k: 'web', l: 'Website', d: 'www.royaltraders.in', on: 'StudioTools.cardRefresh()' },
    { k: 'addr', l: 'Address', d: '12/45 Main Road, Kozhikode, Kerala', on: 'StudioTools.cardRefresh()' },
    { k: 'c1', l: 'Main colour', t: 'color', d: '#0B1B3A', on: 'StudioTools.cardRefresh()' },
    { k: 'c2', l: 'Accent colour', t: 'color', d: '#D4A537', on: 'StudioTools.cardRefresh()' },
    { k: 'font', l: 'Name font', t: 'select', d: SERIF, o: [], on: 'StudioTools.cardRefresh()' },
    { k: 'icon', l: 'Logo / icon', t: 'select', d: '💼', o: LOGO_ICONS.filter(i => i !== 'initial').map(i => [i, i || 'None']).concat([['initial', 'Initial letter']]), on: 'StudioTools.cardRefresh()' }
  ];
  function cardPages(v, style) {
    const W = 1050, H = 600, f = fontCss(v.font), c1 = v.c1, c2 = v.c2, ink = '#14110F';
    const contacts = [['📞', v.phone], ['✉️', v.email], ['🌐', v.web], ['📍', v.addr]].filter(x => x[1]);
    const init = ((v.company || v.name || 'A').trim()[0] || 'A').toUpperCase();
    const logo = (x, y, size, onDark) => !v.icon ? null : v.icon === 'initial' ? T(init, { left: x, top: y, fontFamily: f, fontSize: size, fill: onDark ? '#fff' : c1, fontWeight: 'bold' }) : E(v.icon, x, y, size);
    const clist = (x, y, maxW, size, color, align) => contacts.map((c, i) => {
      const s = fitSize(c[1], BODY, maxW - size * 1.6, size, '600');
      return [E(c[0], x, y + i * size * 1.75, size * 0.9), T(c[1], { left: x + size * 1.1, top: y + i * size * 1.75, originX: 'left', fontFamily: BODY, fontWeight: '600', fontSize: s, fill: color })];
    }).flat();
    const nm = (x, y, maxW, base, fill, ox) => T(v.name || 'Your Name', { left: x, top: y, originX: ox || 'left', fontFamily: f, fontSize: fitSize(v.name || 'Your Name', f, maxW, base), fill });
    const ttl = (x, y, maxW, base, fill, ox) => v.title ? T(v.title, { left: x, top: y, originX: ox || 'left', fontFamily: BODY, fontWeight: '700', fontSize: fitSize(v.title, BODY, maxW, base, '700'), fill, charSpacing: 120 }) : null;
    const comp = (x, y, maxW, base, fill, ox) => v.company ? T(v.company, { left: x, top: y, originX: ox || 'left', fontFamily: BODY, fontWeight: '800', fontSize: fitSize(v.company, BODY, maxW, base, '800'), fill, charSpacing: 150 }) : null;
    const pk = l => l.filter(Boolean);
    let front, fbg;
    if (style === 0) { // classic: left panel
      fbg = '#ffffff';
      front = pk([R(190, H / 2, 380, H, { fill: c1 }), R(385, H / 2, 10, H, { fill: c2 }), logo(190, 250, 170, true), comp(190, 400, 330, 36, '#fff', 'center'), v.tag ? T(v.tag, { left: 190, top: 450, fontFamily: BODY, fontSize: fitSize(v.tag, BODY, 320, 24), fill: c2, fontStyle: 'italic' }) : null, nm(440, 130, 560, 64, c1), ttl(440, 190, 560, 26, '#555'), ...clist(450, 290, 560, 25, ink)]);
    } else if (style === 1) { // modern dark
      fbg = { type: 'gradient', c1: c1, c2: '#000000', angle: 135 };
      front = pk([R(W / 2, 14, W, 28, { fill: c2 }), nm(70, 150, 640, 74, '#fff'), ttl(70, 215, 640, 28, c2), R(70 + 110, 262, 220, 5, { fill: c2 }), ...clist(75, 340, 620, 26, '#e8e8e8'), logo(880, 190, 190, true), comp(880, 330, 260, 30, c2, 'center')]);
    } else if (style === 2) { // centered light
      fbg = '#fbf6ea';
      front = pk([R(W / 2, H / 2, W - 50, H - 50, { fill: 'transparent', stroke: c2, strokeWidth: 3 }), logo(W / 2, 95, 90, false), nm(W / 2, 185, 800, 70, c1, 'center'), ttl(W / 2, 245, 700, 26, '#555', 'center'), R(W / 2, 292, 160, 4, { fill: c2 }), contacts.length ? T(contacts.slice(0, 2).map(c => c[1]).join('    •    '), { left: W / 2, top: 350, fontFamily: BODY, fontWeight: '600', fontSize: fitSize(contacts.slice(0, 2).map(c => c[1]).join('    •    '), BODY, 880, 28, '600'), fill: ink }) : null, contacts.length > 2 ? T(contacts.slice(2).map(c => c[1]).join('    •    '), { left: W / 2, top: 410, fontFamily: BODY, fontWeight: '600', fontSize: fitSize(contacts.slice(2).map(c => c[1]).join('    •    '), BODY, 880, 26, '600'), fill: '#444' }) : null, comp(W / 2, 505, 800, 30, c1, 'center')]);
    } else if (style === 3) { // bold band
      fbg = '#ffffff';
      front = pk([R(W / 2, 135, W, 270, { fill: c1 }), R(W / 2, 270, W, 10, { fill: c2 }), nm(70, 105, 700, 80, '#fff'), ttl(70, 190, 700, 30, c2), logo(900, 135, 150, true), ...clist(75, 345, 560, 26, ink), comp(W - 70, 500, 360, 30, c1, 'right'), v.tag ? T(v.tag, { left: W - 70, top: 545, originX: 'right', fontFamily: BODY, fontSize: fitSize(v.tag, BODY, 360, 22), fill: '#666', fontStyle: 'italic' }) : null]);
    } else if (style === 4) { // diagonal accent
      fbg = '#ffffff';
      front = pk([new F.Polygon([{ x: 640, y: 0 }, { x: 1050, y: 0 }, { x: 1050, y: 600 }, { x: 440, y: 600 }], { fill: c1 }), new F.Polygon([{ x: 600, y: 0 }, { x: 640, y: 0 }, { x: 440, y: 600 }, { x: 400, y: 600 }], { fill: c2 }), nm(60, 130, 500, 62, c1), ttl(60, 190, 480, 24, '#555'), comp(60, 255, 460, 28, c2), logo(850, 180, 190, true), ...clist(680, 330, 340, 22, '#ffffff')].map(o => o));
    } else { // minimal
      fbg = '#ffffff';
      front = pk([R(70, H / 2, 8, 400, { fill: c2, originX: 'left' }), nm(120, 170, 820, 78, c1), ttl(120, 235, 780, 28, '#555'), ...clist(125, 330, 800, 26, ink), comp(W - 70, 520, 420, 30, c1, 'right')]);
    }
    const back = { bg: style === 2 || style === 5 ? c1 : { type: 'gradient', c1: c1, c2: isDark(c1) ? '#000000' : '#ffffff', angle: 150 }, objs: pk([SH('burst16', W / 2, H / 2, 560, 'rgba(255,255,255,0.06)'), logo(W / 2, 220, 170, true), T(v.company || v.name || 'Your Company', { left: W / 2, top: 350, fontFamily: f, fontSize: fitSize(v.company || v.name || 'Your Company', f, 800, 76), fill: '#fff' }), v.tag ? T(v.tag, { left: W / 2, top: 425, fontFamily: BODY, fontWeight: '700', fontSize: fitSize(v.tag, BODY, 700, 28, '700'), fill: c2, charSpacing: 200 }) : null, v.web ? T(v.web, { left: W / 2, top: 530, fontFamily: BODY, fontWeight: '600', fontSize: 26, fill: 'rgba(255,255,255,.85)' }) : null]) };
    return [{ bg: fbg, objs: front }, back];
  }
  let cardStyle = 0;
  function openCard() {
    const fl = StudioLib.fontList(); CARD_FIELDS.find(f => f.k === 'font').o = fl.map(x => [x.css, x.label]);
    dlg('Business Card Maker', `<div class="studio-form">${fields(CARD_FIELDS, 'bc')}
      <label class="studio-label">Pick a layout (front)</label><div class="studio-variants" id="studioCardVars"></div>
      <p class="studio-hint">Creates a 2-page design (front + back), 88.9 × 50.8 mm. Use Export → Print-ready PDF (300 DPI) with "All pages".</p>
      <div class="studio-actions"><button class="btn btn-outline" onclick="StudioTools.openHub()">Back</button><button class="btn btn-primary" onclick="StudioTools.cardUse()">Use this card</button></div></div>`);
    cardStyle = 0; cardRefresh();
  }
  let cardTimer = null;
  function cardRefresh() {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(async () => {
      const v = collect(CARD_FIELDS, 'bc'); await A().ensureFonts([fontCss(v.font)], v.name);
      const box = document.getElementById('studioCardVars'); if (!box) return;
      box.innerHTML = [0, 1, 2, 3, 4, 5].map(i => `<img class="${i === cardStyle ? 'sel' : ''}" src="${thumbOf(cardPages(v, i)[0], 1050, 600, 300)}" onclick="StudioTools.cardPick(${i})">`).join('');
    }, 250);
  }
  function cardPick(i) { cardStyle = i; document.querySelectorAll('#studioCardVars img').forEach((im, j) => im.classList.toggle('sel', i === j)); }
  async function cardUse() {
    const v = collect(CARD_FIELDS, 'bc'); await A().ensureFonts([fontCss(v.font)], v.name);
    openBuilt((v.name || 'Business') + ' card', 1050, 600, cardPages(v, cardStyle), 'card', { w: 88.9, h: 50.8 });
    toast('Business card created (front + back)');
  }

  // ===================================================================================
  // SOCIAL MEDIA STUDIO
  // ===================================================================================
  const SOCIAL_MAP = { 'ig-post': 'igpost', 'ig-port': 'igpost', 'ig-story': 'igstory', 'fb-post': 'fbpost', 'yt-thumb': 'youtube', 'wa-status': 'wastatus', 'wa-post': 'offer' };
  function openSocial() {
    const list = PRESETS.filter(p => p.g === 'Social');
    dlg('Social Media Studio', `<p class="studio-hint" style="margin-top:0">Pick a format. Start blank, or start from a ready layout that re-flows to that size.</p>
      <div class="studio-list">${list.map(p => `<div style="display:flex;gap:6px;align-items:center"><span style="flex:1;font-weight:700;font-size:13px">${esc(p.label)}</span><button class="btn btn-outline btn-sm" onclick="StudioTools.newFromPreset('${p.id}')">Blank</button><button class="btn btn-primary btn-sm" onclick="StudioTools.newFromPreset('${p.id}',true)">Layout</button></div>`).join('')}</div>
      <div class="studio-actions"><button class="btn btn-outline" onclick="StudioTools.openHub()">Back</button></div>`);
  }
  async function newFromPreset(id, withLayout) {
    const p = preset(id); if (!p) return;
    Studio.api.flushSave();
    if (withLayout) {
      const cat = SOCIAL_MAP[id] || 'offer';
      const t = StudioTpl.templates.find(x => x.cat === cat) || StudioTpl.templates[0];
      closeDlg(); await StudioTpl.useTemplate(Object.assign({}, t), [p.w, p.h]);
      A().setSize(p.w, p.h, p.mm || null, false);
    } else { A().newDoc(p.label.replace(/ \(.*/, ''), p.w, p.h, p.mm || null, 'design'); closeDlg(); Studio.closeDrawer(); }
  }
  function applyPreset(id) {
    const p = preset(id); if (!p) return;
    A().setSize(p.w, p.h, p.mm || null, true); toast('Resized to ' + p.label.replace(/ \(.*/, ''));
  }

  // ===================================================================================
  // PRINT DOCUMENTS (multi-page)
  // ===================================================================================
  const DOC_TYPES = {
    flyer: { label: 'Flyer', icon: '📄', size: 'a4', f: [
      { k: 'head', l: 'Headline', d: 'GRAND OPENING SALE' }, { k: 'tag', l: 'Top tag', d: 'THIS WEEKEND ONLY' }, { k: 'sub', l: 'Description', t: 'area', r: 3, d: 'Visit our new showroom and enjoy special launch offers on every product.' },
      { k: 'cta', l: 'Button text', d: 'Visit Us Today' }, { k: 'badge', l: 'Badge (use ⏎ for 2 lines)', d: '50%\nOFF' }, { k: 'foot', l: 'Contact line', d: '📞 98765 43210   📍 Your Location' },
      { k: 'pal', l: 'Colour theme', t: 'select', d: 'fire', o: 'fire,navy,emerald,royal,ocean,gold,rose,sun,forest,teal,berry'.split(',').map(x => [x, x]) },
      { k: 'lay', l: 'Layout', t: 'select', d: 'burst', o: [['burst', 'Bold burst'], ['photo', 'Photo + price'], ['split', 'Split panel'], ['minimal', 'Minimal']] }] },
    invitation: { label: 'Invitation', icon: '💌', size: 'invite', f: [
      { k: 'kicker', l: 'Small top line', d: 'TOGETHER WITH THEIR FAMILIES' }, { k: 'names', l: 'Main names / title', d: 'Aisha & Rahul' }, { k: 'head', l: 'Heading', d: 'Wedding Invitation' },
      { k: 'line1', l: 'Date & time', d: 'Saturday, 12 December 2026 • 11:00 AM' }, { k: 'line2', l: 'Venue', d: 'Royal Garden Auditorium, Your City' }, { k: 'line3', l: 'Bottom line', d: 'RSVP: 98765 43210' },
      { k: 'pal', l: 'Colour theme', t: 'select', d: 'cream', o: 'cream,gold,rose,navy,emerald,royal'.split(',').map(x => [x, x]) },
      { k: 'dark', l: 'Style', t: 'select', d: '0', o: [['0', 'Light'], ['1', 'Dark']] }, { k: 'emoji', l: 'Top emoji', d: '💍' }] },
    menu: { label: 'Menu card', icon: '🍽️', size: 'a4', f: [
      { k: 'title', l: 'Restaurant name', d: 'Spice Garden' }, { k: 'sub', l: 'Subtitle', d: 'AUTHENTIC KERALA CUISINE' },
      { k: 'items', l: 'Items (one per line:  Name - Price ; start a line with # for a section)', t: 'area', r: 9, d: '# Starters\nChicken 65 - 180\nGobi Manchurian - 140\n# Main Course\nMalabar Biryani - 220\nKerala Parotta - 20\nBeef Fry - 210\n# Desserts\nPayasam - 80' },
      { k: 'foot', l: 'Footer', d: '📞 98765 43210   📍 Your Location' },
      { k: 'pal', l: 'Colour theme', t: 'select', d: 'forest', o: 'forest,gold,fire,navy,rose,teal,royal'.split(',').map(x => [x, x]) }] },
    brochure: { label: 'Brochure (bi-fold)', icon: '📘', size: 'a4l', f: [
      { k: 'title', l: 'Company / title', d: 'Royal Traders' }, { k: 'tag', l: 'Tagline', d: 'YOUR TRUSTED PARTNER' }, { k: 'intro', l: 'Cover text', t: 'area', r: 2, d: 'Quality products and services since 1998.' },
      { k: 'h1', l: 'Column 1 heading', d: 'Our Services' }, { k: 't1', l: 'Column 1 text', t: 'area', r: 4, d: 'Wholesale supply\nRetail showroom\nHome delivery\nAfter-sales support' },
      { k: 'h2', l: 'Column 2 heading', d: 'Why Choose Us' }, { k: 't2', l: 'Column 2 text', t: 'area', r: 4, d: 'Best price guarantee\n25 years of experience\nTrained professionals\nEasy payment options' },
      { k: 'h3', l: 'Column 3 heading', d: 'Contact' }, { k: 't3', l: 'Column 3 text', t: 'area', r: 4, d: '📞 98765 43210\n✉️ info@royaltraders.in\n🌐 www.royaltraders.in\n📍 Main Road, Kozhikode' },
      { k: 'pal', l: 'Colour theme', t: 'select', d: 'navy', o: 'navy,emerald,fire,royal,ocean,gold,teal,rose'.split(',').map(x => [x, x]) }] },
    catalogue: { label: 'Product catalogue', icon: '📒', size: 'a4', f: [
      { k: 'title', l: 'Catalogue title', d: 'Product Catalogue 2026' }, { k: 'brand', l: 'Brand name', d: 'Royal Traders' },
      { k: 'items', l: 'Products (one per line:  Name - Price)', t: 'area', r: 9, d: 'Steel Bottle 1L - ₹299\nLunch Box Set - ₹499\nCopper Jug - ₹799\nNon-stick Pan - ₹649\nPressure Cooker 5L - ₹1,299\nDinner Set 24pc - ₹1,899\nCasserole Set - ₹999\nWater Dispenser - ₹1,499' },
      { k: 'foot', l: 'Contact line', d: '📞 98765 43210   🌐 www.royaltraders.in' },
      { k: 'pal', l: 'Colour theme', t: 'select', d: 'teal', o: 'teal,navy,fire,royal,forest,gold,rose'.split(',').map(x => [x, x]) }] }
  };
  const DOC_SIZES = { a4: ['A4', 1240, 1754, { w: 210, h: 297 }], a4l: ['A4 landscape', 1754, 1240, { w: 297, h: 210 }], invite: ['Invitation', 750, 1050, { w: 127, h: 178 }] };
  const palOf = id => StudioTpl.PAL[id] || StudioTpl.PAL.navy;

  function parseItems(txt) {
    const out = []; String(txt || '').split('\n').forEach(l => {
      l = l.trim(); if (!l) return;
      if (l[0] === '#') { out.push({ sec: l.replace(/^#+\s*/, '') }); return; }
      const m = l.split(/\s+[-–—]\s+|\s{2,}/); out.push({ name: m[0].trim(), price: (m[1] || '').trim() });
    }); return out;
  }
  function menuPages(v, W, H) {
    const p = palOf(v.pal), items = parseItems(v.items), pages = [], m = W * 0.09;
    const rowH = H * 0.045, secH = H * 0.07, top = H * 0.24, bot = H * 0.1, avail = H - top - bot;
    let cur = [], used = 0;
    items.forEach(it => { const h = it.sec ? secH : rowH; if (used + h > avail && cur.length) { pages.push(cur); cur = []; used = 0; } cur.push(it); used += h; });
    if (cur.length) pages.push(cur); if (!pages.length) pages.push([]);
    return pages.map((chunk, pi) => {
      const o = [];
      o.push(R(W / 2, H * 0.09, W, H * 0.18, { fill: p.bg[0] }), R(W / 2, H * 0.18, W, 8, { fill: p.accent }));
      o.push(T(v.title || 'Menu', { left: W / 2, top: H * 0.075, fontFamily: SERIF, fontWeight: '900', fontSize: fitSize(v.title || 'Menu', SERIF, W * 0.8, H * 0.06, '900'), fill: '#fff' }));
      if (v.sub) o.push(T(v.sub, { left: W / 2, top: H * 0.128, fontFamily: BODY, fontWeight: '800', fontSize: fitSize(v.sub, BODY, W * 0.7, H * 0.02, '800'), fill: p.accent, charSpacing: 300 }));
      let y = top;
      chunk.forEach(it => {
        if (it.sec) { o.push(T(it.sec.toUpperCase(), { left: m, top: y + secH * 0.5, originX: 'left', fontFamily: SERIF, fontWeight: '900', fontSize: H * 0.027, fill: p.bg[0], charSpacing: 200 }), R(W / 2, y + secH * 0.88, W - m * 2, 3, { fill: p.accent })); y += secH; }
        else {
          const fs = H * 0.022; o.push(T(it.name, { left: m, top: y + rowH / 2, originX: 'left', fontFamily: BODY, fontWeight: '700', fontSize: fitSize(it.name, BODY, W * 0.6, fs, '700'), fill: p.ink }));
          if (it.price) { o.push(T(it.price, { left: W - m, top: y + rowH / 2, originX: 'right', fontFamily: BODY, fontWeight: '800', fontSize: fs, fill: p.bg[0] })); }
          o.push(new F.Line([m, y + rowH - 2, W - m, y + rowH - 2], { stroke: 'rgba(0,0,0,0.12)', strokeWidth: 2, strokeDashArray: [4, 8] })); y += rowH;
        }
      });
      o.push(R(W / 2, H - H * 0.04, W, H * 0.08, { fill: p.bg[0] }), T((v.foot || '') + (pages.length > 1 ? `     ${pi + 1}/${pages.length}` : ''), { left: W / 2, top: H - H * 0.04, fontFamily: BODY, fontWeight: '700', fontSize: H * 0.018, fill: '#fff' }));
      return { bg: p.light, objs: o };
    });
  }
  function brochurePages(v, W, H) {
    const p = palOf(v.pal), cx = W / 2, objs1 = [], objs2 = [], u = H;
    // page 1: cover
    objs1.push(SH('burst16', W * 0.78, H * 0.5, u * 1.1, 'rgba(255,255,255,0.08)'), C(W * 0.78, H * 0.5, u * 0.33, { fill: 'rgba(255,255,255,0.15)' }));
    objs1.push(T(v.tag || '', { left: W * 0.07, top: H * 0.3, originX: 'left', fontFamily: BODY, fontWeight: '800', fontSize: u * 0.03, fill: p.accent, charSpacing: 400 }));
    objs1.push(T(v.title || 'Brochure', { left: W * 0.07, top: H * 0.45, originX: 'left', fontFamily: ANTON, fontSize: fitSize(v.title || 'Brochure', ANTON, W * 0.55, u * 0.17), fill: '#fff' }));
    objs1.push(TB(v.intro || '', { left: W * 0.07, top: H * 0.56, width: W * 0.45, fontSize: u * 0.033, fill: '#fff', fontWeight: '600' }));
    objs1.push(E('🏢', W * 0.78, H * 0.5, u * 0.36));
    // page 2: three columns
    const cw = W * 0.26, gap = W * 0.04, x0 = (W - (cw * 3 + gap * 2)) / 2;
    objs2.push(R(cx, H * 0.1, W, H * 0.2, { fill: p.bg[0] }), T(v.title || '', { left: cx, top: H * 0.1, fontFamily: ANTON, fontSize: fitSize(v.title || ' ', ANTON, W * 0.7, u * 0.09), fill: '#fff', charSpacing: 100 }));
    [[v.h1, v.t1], [v.h2, v.t2], [v.h3, v.t3]].forEach((c, i) => {
      const x = x0 + i * (cw + gap);
      objs2.push(R(x + cw / 2, H * 0.3, cw, H * 0.012, { fill: p.accent }), TB(c[0] || '', { left: x, top: H * 0.33, width: cw, fontFamily: SERIF, fontWeight: '900', fontSize: fitSize(c[0] || ' ', SERIF, cw, u * 0.05, '900'), fill: p.bg[0] }),
        TB((c[1] || '').split('\n').filter(Boolean).map(l => /^[^\wഀ-ൿऀ-ॿ஀-௿]/.test(l) ? l : '•  ' + l).join('\n'), { left: x, top: H * 0.45, width: cw, fontSize: u * 0.031, fill: p.ink, fontWeight: '600', lineHeight: 1.5 }));
    });
    objs2.push(R(cx, H * 0.96, W, H * 0.08, { fill: p.accent }));
    return [{ bg: { type: 'gradient', c1: p.bg[0], c2: p.bg[1], angle: 120 }, objs: objs1 }, { bg: p.light, objs: objs2 }];
  }
  function cataloguePages(v, W, H) {
    const p = palOf(v.pal), items = parseItems(v.items).filter(i => !i.sec), per = 6, pages = [], cols = 2, rows = 3;
    const chunks = []; for (let i = 0; i < items.length; i += per) chunks.push(items.slice(i, i + per)); if (!chunks.length) chunks.push([]);
    // cover
    const cover = [SH('burst16', W / 2, H * 0.4, W * 1.2, 'rgba(255,255,255,0.08)'), E('🛍️', W / 2, H * 0.38, W * 0.3), T(v.title || 'Catalogue', { left: W / 2, top: H * 0.6, fontFamily: ANTON, fontSize: fitSize(v.title || 'Catalogue', ANTON, W * 0.8, W * 0.12), fill: '#fff' }), T(v.brand || '', { left: W / 2, top: H * 0.69, fontFamily: BODY, fontWeight: '800', fontSize: W * 0.04, fill: p.accent, charSpacing: 400 }), T(v.foot || '', { left: W / 2, top: H * 0.93, fontFamily: BODY, fontWeight: '700', fontSize: W * 0.026, fill: '#fff' })];
    pages.push({ bg: { type: 'gradient', c1: p.bg[0], c2: p.bg[1], angle: 150 }, objs: cover });
    chunks.forEach((ch, pi) => {
      const o = [R(W / 2, H * 0.05, W, H * 0.1, { fill: p.bg[0] }), T(v.brand || v.title || '', { left: W * 0.06, top: H * 0.05, originX: 'left', fontFamily: ANTON, fontSize: H * 0.032, fill: '#fff', charSpacing: 100 }), T(String(pi + 1), { left: W * 0.94, top: H * 0.05, originX: 'right', fontFamily: BODY, fontWeight: '800', fontSize: H * 0.026, fill: p.accent })];
      const mx = W * 0.06, gx = W * 0.04, cw = (W - mx * 2 - gx) / cols, ty = H * 0.13, gy = H * 0.03, chh = (H * 0.78 - gy * (rows - 1)) / rows;
      ch.forEach((it, i) => {
        const cxn = mx + (i % cols) * (cw + gx) + cw / 2, cyn = ty + Math.floor(i / cols) * (chh + gy) + chh / 2;
        o.push(new F.Rect({ left: cxn, top: cyn, originX: 'center', originY: 'center', width: cw, height: chh, rx: 22, ry: 22, fill: '#ffffff', stroke: 'rgba(0,0,0,0.08)', strokeWidth: 2, shadow: new F.Shadow({ color: 'rgba(0,0,0,.12)', blur: 18, offsetX: 0, offsetY: 6 }) }));
        o.push(new F.Rect({ left: cxn, top: cyn - chh * 0.12, originX: 'center', originY: 'center', width: cw - 40, height: chh * 0.62, rx: 14, ry: 14, fill: p.light, stroke: p.bg[0], strokeWidth: 2, strokeDashArray: [10, 8], studioName: 'Photo area' }), E('📷', cxn, cyn - chh * 0.12, cw * 0.18, { opacity: 0.5 }));
        o.push(T(it.name, { left: cxn, top: cyn + chh * 0.32, fontFamily: BODY, fontWeight: '800', fontSize: fitSize(it.name, BODY, cw - 50, H * 0.024, '800'), fill: p.ink }));
        if (it.price) o.push(T(it.price, { left: cxn, top: cyn + chh * 0.42, fontFamily: ANTON, fontSize: H * 0.03, fill: p.bg[0] }));
      });
      o.push(R(W / 2, H * 0.965, W, H * 0.07, { fill: p.accent }), T(v.foot || '', { left: W / 2, top: H * 0.965, fontFamily: BODY, fontWeight: '800', fontSize: H * 0.017, fill: p.dark }));
      pages.push({ bg: '#f7f7f5', objs: o });
    });
    return pages;
  }
  function docBuild(type, v) {
    const t = DOC_TYPES[type], [, W, H] = DOC_SIZES[t.size];
    const p = palOf(v.pal);
    const c = { head: v.head, tag: v.tag, sub: v.sub, cta: v.cta, badge: v.badge, foot: v.foot, motif: ['🔥', '🎁', '💥'] };
    if (type === 'flyer') return [StudioTpl.L[v.lay || 'burst'](W, H, c, Object.assign({}, p, { headFont: undefined }), {})];
    if (type === 'invitation') {
      const cc = { head: v.head, sub: v.names, foot: v.line3, motif: [v.emoji || '💍'], invite: { kicker: v.kicker, names: v.names, line1: v.line1, line2: v.line2, line3: v.line3 } };
      return [StudioTpl.L.invite(W, H, cc, Object.assign({}, p), { dark: v.dark === '1', script: true })];
    }
    if (type === 'menu') return menuPages(v, W, H);
    if (type === 'brochure') return brochurePages(v, W, H);
    return cataloguePages(v, W, H);
  }
  let docType = 'flyer';
  function openDocs(type) {
    docType = type || docType; const t = DOC_TYPES[docType];
    dlg(t.label + ' Maker', `<div class="studio-chiprow">${Object.entries(DOC_TYPES).map(([k, d]) => `<button class="studio-chip ${k === docType ? 'active' : ''}" onclick="StudioTools.openDocs('${k}')">${d.icon} ${d.label}</button>`).join('')}</div>
      <div class="studio-form">${fields(t.f, 'dc')}
      <label class="studio-label">Preview</label><div class="studio-variants" id="studioDocPrev" style="grid-template-columns:repeat(3,1fr)"></div>
      <p class="studio-hint">Opens as a multi-page design in ${DOC_SIZES[t.size][0]}. Export → PDF with "All pages" for a single multi-page file, or Print-ready PDF (300 DPI).</p>
      <div class="studio-actions"><button class="btn btn-outline" onclick="StudioTools.openHub()">Back</button><button class="btn btn-primary" onclick="StudioTools.docUse()">Create design</button></div></div>`);
    t.f.forEach(f => { const e = document.getElementById('dc_' + f.k); if (e) { e.addEventListener('input', docRefresh); e.addEventListener('change', docRefresh); } });
    docRefresh();
  }
  let docTimer = null;
  function docRefresh() {
    clearTimeout(docTimer);
    docTimer = setTimeout(async () => {
      const t = DOC_TYPES[docType], v = collect(t.f, 'dc'); await A().ensureFonts([ANTON, SERIF, BODY], v.head || v.title || 'Aa');
      const box = document.getElementById('studioDocPrev'); if (!box) return;
      const [, W, H] = DOC_SIZES[t.size];
      try { box.innerHTML = docBuild(docType, v).slice(0, 3).map(sp => `<img src="${thumbOf(sp, W, H, 260)}">`).join(''); } catch (e) { console.error(e); box.innerHTML = '<p class="studio-hint">Preview failed — check the fields.</p>'; }
    }, 300);
  }
  async function docUse() {
    const t = DOC_TYPES[docType], v = collect(t.f, 'dc'), [, W, H, mm] = DOC_SIZES[t.size];
    await A().ensureFonts([ANTON, SERIF, BODY], v.head || v.title || 'Aa');
    openBuilt(v.title || v.head || v.names || t.label, W, H, docBuild(docType, v), docType, mm);
    toast(t.label + ' created');
  }

  // ===================================================================================
  // HUB + entry points
  // ===================================================================================
  function openHub() {
    const tiles = [
      ['🅰️', 'Logo Maker', 'Name → 12 logo styles', 'StudioTools.openLogo()'],
      ['💼', 'Business Card', 'Front + back, print PDF', 'StudioTools.openCard()'],
      ['📱', 'Social Media Studio', 'Instagram · Facebook · YouTube · WhatsApp', 'StudioTools.openSocial()'],
      ['📄', 'Flyer', 'A4 print flyer', "StudioTools.openDocs('flyer')"],
      ['💌', 'Invitation', 'Wedding, birthday, events', "StudioTools.openDocs('invitation')"],
      ['🍽️', 'Menu Card', 'Auto multi-page menu', "StudioTools.openDocs('menu')"],
      ['📘', 'Brochure', 'Bi-fold, 2 pages', "StudioTools.openDocs('brochure')"],
      ['📒', 'Catalogue', 'Product grid pages', "StudioTools.openDocs('catalogue')"],
      ['🎬', 'Video Maker', 'Slideshow, text, music', 'StudioTools.closeDlg();window.VideoMaker&&VideoMaker.open()'],
      ['📐', 'Custom size', 'Blank design, any size', 'StudioTools.openCustom()'],
      ['🗂️', 'My Designs', 'Saved, favourites, uploads', 'StudioTools.closeDlg();window.StudioStore&&StudioStore.openMyDesigns()']
    ];
    if (window.StudioStore && StudioStore.isAdmin()) tiles.push(['🛠️', 'Admin', 'Users, templates, pricing', 'StudioStore.openAdmin()']);
    dlg('Makers & Tools', `<div class="studio-hub">${tiles.map(t => `<button onclick="${t[3]}"><span>${t[0]}</span>${t[1]}<small>${t[2]}</small></button>`).join('')}</div>`);
  }
  function openCustom() {
    dlg('New design', `<div class="studio-form"><label class="studio-label">Format</label><select id="nd_preset" class="studio-select">${['Social', 'Print', 'Web', 'Other'].map(g => `<optgroup label="${g}">${PRESETS.filter(p => p.g === g).map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</optgroup>`).join('')}<option value="custom">Custom size…</option></select>
      <div class="studio-size-row" style="margin-top:10px"><input type="number" id="nd_w" value="1080" min="50" max="6000"><span>×</span><input type="number" id="nd_h" value="1080" min="50" max="6000"><span>px</span></div>
      <div class="studio-actions"><button class="btn btn-outline" onclick="StudioTools.openHub()">Back</button><button class="btn btn-primary" onclick="StudioTools.customCreate()">Create</button></div></div>`);
  }
  function customCreate() {
    const id = $v('nd_preset'); Studio.api.flushSave();
    if (id === 'custom') A().newDoc('Custom design', parseInt($v('nd_w')) || 1080, parseInt($v('nd_h')) || 1080, null, 'design');
    else { const p = preset(id); A().newDoc(p.label.replace(/ \(.*/, ''), p.w, p.h, p.mm || null, 'design'); }
    closeDlg(); Studio.closeDrawer();
  }
  const ENTRY = { hub: openHub, logo: openLogo, card: openCard, social: openSocial, flyer: () => openDocs('flyer'), invitation: () => openDocs('invitation'), menu: () => openDocs('menu'), brochure: () => openDocs('brochure'), catalogue: () => openDocs('catalogue'), templates: () => Studio.openDrawer('templates'), custom: openCustom, video: () => window.VideoMaker && VideoMaker.open(), mydesigns: () => window.StudioStore && StudioStore.openMyDesigns() };
  function open(name) { (ENTRY[name] || openHub)(); }
  // Called from the Home screen tiles: switch to the studio screen, then open a tool.
  window.openStudioTool = function (name) {
    goto('studio');
    setTimeout(() => { try { open(name); } catch (e) { console.error(e); toast('Could not open ' + name, true); } }, 120);
  };

  // Size-preset tab in the drawer + preset dropdown in the Design panel.
  function renderSizesTab(body) {
    body.innerHTML = ['Social', 'Print', 'Web', 'Other'].map(g => `<label class="studio-label">${g}</label><div class="studio-list">${PRESETS.filter(p => p.g === g).map(p => `<div style="display:flex;gap:6px;align-items:center"><span style="flex:1;font-size:12.5px;font-weight:700">${esc(p.label)}</span><button class="btn btn-outline btn-sm" onclick="StudioTools.newFromPreset('${p.id}')">New</button><button class="btn btn-primary btn-sm" onclick="StudioTools.applyPreset('${p.id}')">Resize</button></div>`).join('')}</div>`).join('') + '<p class="studio-hint">“Resize” rescales the current design to the new size. “New” starts a blank design.</p>';
  }
  Studio.registerTab({ id: 'sizes', label: 'Sizes', icon: '📐', order: 60, render: renderSizesTab });
  (function fillPresetSelect() {
    const sel = document.getElementById('studioPresetSel'); if (!sel) return;
    sel.innerHTML = '<option value="">Choose a size…</option>' + ['Social', 'Print', 'Web', 'Other'].map(g => `<optgroup label="${g}">${PRESETS.filter(p => p.g === g).map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</optgroup>`).join('');
  })();

  return { PRESETS, preset, dlg, closeDlg, openHub, openLogo, openCard, openSocial, openDocs, openCustom, customCreate, open, logoRefresh, logoPick, logoUse, cardRefresh, cardPick, cardUse, newFromPreset, applyPreset, docUse, logoVariants, cardPages, docBuild, DOC_TYPES, parseItems };
})();


// ======================= studio-store.js =======================
// ===================================================================================
// DESIGN STUDIO — storage, plan rules, My Designs and Admin dashboard.
//  * Designs / uploads / export history live in IndexedDB (works offline, handles big images).
//  * If the optional Supabase table `studio_designs` exists, designs also sync to the cloud
//    (run the SQL shown in Admin → Setup once). If it doesn't, the Studio keeps working locally.
//  * Plan rules mirror the existing poster editor: free users get a watermark and the same daily
//    download limit; hi-res / transparent / print-ready PDF need a paid plan.
//    NO payment is processed here — locked actions send people to the existing payment screen.
//  * Admin dashboard is only shown when profiles.is_admin = true. Client-side checks are only a
//    convenience: real protection must come from the Row Level Security SQL in Admin → Setup.
// ===================================================================================
var StudioStore = (() => {
  const A = () => Studio.api;
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const CONFIG = { freeHiRes: false, freeTransparent: false, freePrintPdf: false, cloudEvery: 15000, maxUploads: 80, maxDesigns: 300, freeSaveLimit: 1 };

  // ------------------------------------------------------------------ IndexedDB
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
      const r = indexedDB.open('offer_studio', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('designs')) d.createObjectStore('designs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('uploads')) d.createObjectStore('uploads', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store), q = fn(s); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  const put = (store, v) => tx(store, 'readwrite', s => s.put(v));
  const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
  const getAll = store => tx(store, 'readonly', s => s.getAll()).then(r => r || []);
  const getOne = (store, id) => tx(store, 'readonly', s => s.get(id));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const userId = () => (window.STATE && STATE.user && STATE.user.id) || null;
  const plan = () => (window.STATE && STATE.profile && STATE.profile.plan) || 'free';
  const isAdmin = () => !!(window.STATE && STATE.profile && STATE.profile.is_admin === true);

  // ------------------------------------------------------------------ autosave
  let cloudOK = true, lastCloud = 0, saving = false, pending = null, thumbBusy = false;
  const isEmptyDoc = doc => doc.kind === 'design' && doc.pages.length === 1 && !doc.id && (JSON.parse(doc.pages[0]).objects || []).length === 0;

  function thumbFromJSON(json, W, H, max) {
    return new Promise(resolve => {
      try {
        const s = max / Math.max(W, H), sc = new fabric.StaticCanvas(null, { width: Math.round(W * s), height: Math.round(H * s) });
        sc.loadFromJSON(json, () => { try { sc.setZoom(s); sc.renderAll(); const u = sc.toDataURL({ format: 'jpeg', quality: 0.7 }); sc.dispose && sc.dispose(); resolve(u); } catch (e) { resolve(''); } });
      } catch (e) { resolve(''); }
    });
  }
  const saveLimit = () => { const v = window.STATE && STATE.settings && STATE.settings.free_save_limit; return v == null ? CONFIG.freeSaveLimit : Number(v); };
  const noticed = new Set();
  function limitNotice(id, explicit) {
    setSaveState('Not saved — free limit reached');
    if (explicit) { toast('Free plan allows ' + saveLimit() + ' saved design — upgrade to save more', true); if (window.goto) { goto('payment'); } return; }
    if (!noticed.has(id)) { noticed.add(id); toast('Free plan: only ' + saveLimit() + ' saved design. This one is not being saved — upgrade or tap 💾 to see plans', true); }
  }
  async function autosave(doc, force, explicit) {
    if (!doc) return;
    if (isEmptyDoc(doc)) return;
    if (saving) { pending = doc; return; }
    saving = true; let ok = false;
    try {
      if (!doc.id) { doc.id = uid(); A().setDocId(doc.id); }
      const prev = await getOne('designs', doc.id).catch(() => null);
      if (!prev && plan() === 'free') { // free plan: only N saved designs (default 1), then a plan is needed
        const mine = (await getAll('designs')).filter(d => !d.userId || d.userId === userId());
        if (mine.length >= saveLimit()) { limitNotice(doc.id, explicit); saving = false; if (pending) { pending = null; } return false; }
      }
      let thumb = prev && prev.thumb || '';
      if (!thumbBusy) { thumbBusy = true; thumb = (await thumbFromJSON(doc.pages[doc.pageIndex || 0], doc.width, doc.height, 260)) || thumb; thumbBusy = false; }
      const rec = { id: doc.id, userId: userId(), name: doc.name, kind: doc.kind, width: doc.width, height: doc.height, mm: doc.mm, pageIndex: doc.pageIndex, pages: doc.pages, thumb, updated: Date.now(), created: prev ? prev.created : Date.now() };
      await put('designs', rec);
      setSaveState('Saved'); ok = true;
      if (force || Date.now() - lastCloud > CONFIG.cloudEvery) cloudSave(rec);
    } catch (e) { console.warn('autosave failed', e); setSaveState('Not saved (storage full?)'); }
    saving = false;
    if (pending) { const p = pending; pending = null; autosave(p); }
    return ok;
  }
  async function cloudSave(rec) {
    if (!cloudOK || !window.sb || !userId()) return;
    lastCloud = Date.now();
    const { error } = await sb.from('studio_designs').upsert({ id: rec.id, user_id: userId(), name: rec.name, width: rec.width, height: rec.height, thumb: rec.thumb, updated_at: new Date().toISOString(), doc: { kind: rec.kind, mm: rec.mm, pageIndex: rec.pageIndex, pages: rec.pages } });
    if (error) { cloudOK = false; console.info('Studio cloud sync off:', error.message); }
  }
  function setSaveState(t) { const el = document.getElementById('studioDesignName'); if (el) el.title = t; }
  function saveNow(announce) {
    const doc = A().getDoc();
    if (isEmptyDoc(doc)) { if (announce) toast('Nothing to save yet'); return; }
    autosave(doc, true, true).then(ok => { if (announce && ok) toast(cloudOK && userId() ? 'Saved (this device + cloud)' : 'Saved on this device'); });
  }

  // ------------------------------------------------------------------ enter: pull cloud + admin content
  let entered = false;
  async function onEnterStudio() {
    if (entered) return; entered = true;
    if (!window.sb || !userId()) return;
    try {
      const { data, error } = await sb.from('studio_designs').select('id,name,width,height,thumb,doc,updated_at').eq('user_id', userId()).order('updated_at', { ascending: false }).limit(100);
      if (error) { cloudOK = false; } else if (data) {
        for (const r of data) {
          const local = await getOne('designs', r.id).catch(() => null), t = new Date(r.updated_at).getTime();
          if (!local || local.updated < t - 2000) await put('designs', { id: r.id, userId: userId(), name: r.name, kind: r.doc.kind, width: r.width, height: r.height, mm: r.doc.mm, pageIndex: r.doc.pageIndex || 0, pages: r.doc.pages, thumb: r.thumb, updated: t, created: t });
        }
      }
    } catch (e) { cloudOK = false; }
    loadAdminContent();
  }
  async function loadAdminContent() {
    try {
      const t = await sb.from('studio_templates').select('*').order('created_at', { ascending: false }).limit(200);
      if (!t.error && t.data) StudioTpl.addExtra(t.data.map(r => ({ id: 'db-' + r.id, cat: r.cat || 'custom', catLabel: r.cat || 'Custom', name: r.name, premium: !!r.premium, tags: r.tags || '', thumb: r.thumb, doc: r.doc, size: 'post', head: r.name })));
      const f = await sb.from('studio_fonts').select('*');
      if (!f.error && f.data) f.data.forEach(r => {
        if (r.url && !document.querySelector(`link[data-sfont="${r.id}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = r.url; l.dataset.sfont = r.id; document.head.appendChild(l); }
        if (typeof FONT_OPTIONS !== 'undefined' && !FONT_OPTIONS.find(x => x.css === r.css)) FONT_OPTIONS.push({ id: 'db-' + r.id, label: r.label, css: r.css });
      });
    } catch (e) { /* tables are optional */ }
  }

  // ------------------------------------------------------------------ uploads
  function downscale(dataURL, max) {
    return new Promise(res => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)); if (s === 1 && dataURL.length < 900000) return res(dataURL); const c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL(/png/.test(dataURL.slice(0, 20)) ? 'image/png' : 'image/jpeg', 0.88)); }; im.onerror = () => res(dataURL); im.src = dataURL; });
  }
  async function addUpload(name, dataURL) {
    try {
      const url = await downscale(dataURL, 1600), all = await getAll('uploads');
      if (all.length >= CONFIG.maxUploads) { all.sort((a, b) => a.ts - b.ts); await del('uploads', all[0].id); }
      await put('uploads', { id: uid(), userId: userId(), name, url, ts: Date.now() });
    } catch (e) { console.warn('upload store failed', e); }
  }
  async function renderUploads(body) {
    const list = (await getAll('uploads')).filter(u => !u.userId || u.userId === userId()).sort((a, b) => b.ts - a.ts);
    body.innerHTML = `<div class="studio-actions" style="margin-top:0"><button class="btn btn-primary btn-sm" onclick="document.getElementById('studioImgInput').click()">⬆ Upload image</button></div>` +
      (list.length ? `<div class="studio-grid" style="margin-top:10px">${list.map(u => `<div class="studio-cell bg" style="position:relative"><img src="${u.url}" style="width:100%;height:100%;object-fit:cover" onclick="StudioStore.useUpload('${u.id}')"><button style="position:absolute;top:2px;right:2px;border:none;border-radius:50%;width:22px;height:22px;background:rgba(0,0,0,.6);color:#fff;font-size:11px" onclick="StudioStore.delUpload('${u.id}')">✕</button></div>`).join('')}</div>` : '<p class="studio-empty-hint" style="margin-top:12px">Images you upload appear here for reuse.</p>');
  }
  async function useUpload(id) { const u = await getOne('uploads', id); if (u) A().addImageURL(u.url); }
  async function delUpload(id) { await del('uploads', id); Studio.openDrawer('uploads'); }
  Studio.registerTab({ id: 'uploads', label: 'Uploads', icon: '⬆', order: 50, render: renderUploads });

  // ------------------------------------------------------------------ plan rules + export hooks
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const localKey = () => 'studio_dl_' + todayStr();
  const localExtra = () => { try { return parseInt(localStorage.getItem(localKey()) || '0'); } catch (e) { return 0; } };
  const upgrade = msg => { toast(msg, true); try { Studio.exportDialogClose(); } catch (e) { /* ignore */ } try { if (window.VideoMaker) VideoMaker.close(); } catch (e) { /* ignore */ } A().flushSave(); if (window.goto) goto('payment'); return false; };
  async function beforeExport(o) {
    if (plan() !== 'free') { // paid plan: only the plan's download allowance (if the plan has one) applies
      o.watermark = null;
      try { if (typeof planQuotaExceeded === 'function' && await planQuotaExceeded(o.format === 'video' ? 'video' : 'image')) return upgrade('Your plan\'s ' + (o.format === 'video' ? 'video' : 'download') + ' limit is used up — choose a plan to continue'); } catch (e) { /* ignore */ }
      return true;
    }
    if (o.format === 'video') { // free plan: limited number of video downloads (default 1), counted separately from images
      try {
        const lim = (STATE.settings && (STATE.settings.free_video_limit ?? STATE.settings.free_download_limit)) ?? 1;
        let used = parseInt(localStorage.getItem('studio_dlv_' + todayStr()) || '0');
        if (window.sb && userId()) { const { count } = await sb.from('downloads_log').select('id', { count: 'exact', head: true }).eq('user_id', userId()).eq('format', 'studio-video').gte('created_at', todayStr() + 'T00:00:00'); used = Math.max(used, count || 0); }
        if (used >= lim) return upgrade('Free plan includes ' + lim + ' video download — upgrade for unlimited videos');
      } catch (e) { /* don't block if the check itself fails */ }
      return true;
    }
    if (o.print && !CONFIG.freePrintPdf) return upgrade('Print-ready PDF is a Premium feature — upgrade to unlock');
    if (o.multiplier > 1.01 && !o.print && !CONFIG.freeHiRes) return upgrade('High-resolution export is a Premium feature — upgrade to unlock');
    if (o.transparent && !CONFIG.freeTransparent) return upgrade('Transparent PNG is a Premium feature — upgrade to unlock');
    try {
      const limit = (STATE.settings && STATE.settings.free_download_limit) ?? 1;
      let used = localExtra();
      if (window.sb && userId()) { const { count } = await sb.from('downloads_log').select('id', { count: 'exact', head: true }).eq('user_id', userId()).neq('format', 'studio-video').gte('created_at', todayStr() + 'T00:00:00'); used = Math.max(used, count || 0); }
      if (used >= limit) return upgrade('Daily free download limit reached — upgrade for unlimited downloads');
    } catch (e) { /* if the check itself fails, don't block the user */ }
    o.watermark = (STATE.settings && STATE.settings.watermark_text) || 'OFFER POSTER STUDIO';
    return true;
  }
  async function afterExport(o) {
    const d = A().doc(), s = A().size();
    try { await put('history', { id: uid(), userId: userId(), name: o.name || d.name, format: o.format, w: o.w || Math.round(s.w * o.multiplier), h: o.h || Math.round(s.h * o.multiplier), ts: Date.now() }); } catch (e) { /* ignore */ }
    let ok = false;
    try { if (window.sb && userId()) { const r = await sb.from('downloads_log').insert({ user_id: userId(), format: 'studio-' + o.format, size_preset: 'studio', hd: false }); ok = !r.error; } } catch (e) { /* ignore */ }
    if (!ok && plan() === 'free') { try { const k = o.format === 'video' ? 'studio_dlv_' + todayStr() : localKey(); localStorage.setItem(k, String((parseInt(localStorage.getItem(k) || '0')) + 1)); } catch (e) { /* ignore */ } }
  }
  const syncFavs = () => { };

  // ------------------------------------------------------------------ My Designs
  let mdTab = 'designs', mdQuery = '';
  function dialog(title, html) { StudioTools.dlg(title, html); }
  async function openMyDesigns(tab) {
    mdTab = tab || mdTab;
    Studio.api.flushSave();
    const tabs = [['designs', '🗂️ Designs'], ['fav', '♥ Favourites'], ['uploads', '⬆ Uploads'], ['history', '🕘 History']];
    dialog('My Designs', `<div class="studio-chiprow">${tabs.map(([k, l]) => `<button class="studio-chip ${k === mdTab ? 'active' : ''}" onclick="StudioStore.openMyDesigns('${k}')">${l}</button>`).join('')}</div><div id="studioMdBody"><p class="studio-hint">Loading…</p></div>`);
    const body = document.getElementById('studioMdBody');
    if (mdTab === 'designs') {
      const list = (await getAll('designs')).filter(d => !d.userId || d.userId === userId()).sort((a, b) => b.updated - a.updated).filter(d => !mdQuery || (d.name || '').toLowerCase().includes(mdQuery));
      body.innerHTML = `<input class="studio-search" type="search" placeholder="Search my designs" value="${esc(mdQuery)}" oninput="StudioStore.mdSearch(this.value)">` +
        (list.length ? `<div class="studio-tpl-grid">${list.map(d => `<div class="studio-tpl"><div class="studio-tpl-img" onclick="StudioStore.openDesign('${d.id}')">${d.thumb ? `<img src="${d.thumb}">` : ''}</div><div class="studio-tpl-name">${esc(d.name)}<small>${d.width}×${d.height} · ${d.pages.length} page${d.pages.length > 1 ? 's' : ''} · ${new Date(d.updated).toLocaleDateString()}</small></div><div class="studio-tpl-actions"><button class="primary" onclick="StudioStore.openDesign('${d.id}')">Open</button><button onclick="StudioStore.dupDesign('${d.id}')" title="Duplicate">⧉</button><button onclick="StudioStore.renameDesign('${d.id}')" title="Rename">✎</button><button onclick="StudioStore.delDesign('${d.id}')" title="Delete">🗑</button></div></div>`).join('')}</div>` : '<p class="studio-empty-hint">No saved designs yet. Anything you make in the Studio is saved automatically.</p>') +
        `<p class="studio-hint">${cloudOK && userId() ? '☁ Cloud sync is on.' : 'Saved on this device. Ask the site admin to enable cloud sync (Admin → Setup) to open designs on other devices.'}</p>`;
    } else if (mdTab === 'fav') {
      const favs = StudioTpl.favs(), ts = StudioTpl.all().filter(t => favs.includes(t.id));
      body.innerHTML = ts.length ? `<div class="studio-list">${ts.map(t => `<div style="display:flex;gap:6px;align-items:center"><span style="flex:1;font-weight:700;font-size:13px">${esc(t.name)} <small style="color:var(--muted)">${esc(t.catLabel)}</small></span><button class="btn btn-primary btn-sm" onclick="StudioTools.closeDlg();StudioTpl.use('${t.id}')">Use</button></div>`).join('')}</div>` : '<p class="studio-empty-hint">Tap ♡ on any template to save it here.</p>';
    } else if (mdTab === 'uploads') {
      const list = (await getAll('uploads')).filter(u => !u.userId || u.userId === userId()).sort((a, b) => b.ts - a.ts);
      body.innerHTML = list.length ? `<div class="studio-grid">${list.map(u => `<div class="studio-cell bg" style="position:relative"><img src="${u.url}" style="width:100%;height:100%;object-fit:cover" onclick="StudioTools.closeDlg();StudioStore.useUpload('${u.id}')"><button style="position:absolute;top:2px;right:2px;border:none;border-radius:50%;width:22px;height:22px;background:rgba(0,0,0,.6);color:#fff;font-size:11px" onclick="StudioStore.delUpload('${u.id}').then(()=>StudioStore.openMyDesigns('uploads'))">✕</button></div>`).join('')}</div>` : '<p class="studio-empty-hint">No uploads yet.</p>';
    } else {
      const list = (await getAll('history')).filter(h => !h.userId || h.userId === userId()).sort((a, b) => b.ts - a.ts).slice(0, 60);
      body.innerHTML = list.length ? `<table class="studio-table"><tr><th>Design</th><th>Format</th><th>Size</th><th>When</th></tr>${list.map(h => `<tr><td>${esc(h.name)}</td><td>${esc(h.format)}</td><td>${h.w}×${h.h}</td><td>${new Date(h.ts).toLocaleString()}</td></tr>`).join('')}</table>` : '<p class="studio-empty-hint">Exports you download are listed here.</p>';
    }
  }
  let mdT; function mdSearch(v) { mdQuery = v.trim().toLowerCase(); clearTimeout(mdT); mdT = setTimeout(() => openMyDesigns('designs'), 250); }
  async function openDesign(id) {
    const d = await getOne('designs', id); if (!d) return;
    Studio.api.flushSave(); await Studio.api.ensureFonts(StudioLib.allFontCss());
    Studio.api.loadDoc({ id: d.id, name: d.name, kind: d.kind, width: d.width, height: d.height, mm: d.mm, pageIndex: d.pageIndex, pages: d.pages }, { noSave: true });
    StudioTools.closeDlg(); Studio.closeDrawer();
  }
  async function dupDesign(id) { const d = await getOne('designs', id); if (!d) return; await put('designs', Object.assign({}, d, { id: uid(), name: d.name + ' copy', updated: Date.now(), created: Date.now() })); toast('Duplicated'); openMyDesigns('designs'); }
  async function renameDesign(id) { const d = await getOne('designs', id); if (!d) return; const n = prompt('Rename design', d.name); if (!n) return; d.name = n; d.updated = Date.now(); await put('designs', d); if (A().doc().id === id) Studio.rename(n); cloudSave(d); openMyDesigns('designs'); }
  async function delDesign(id) {
    if (!confirm('Delete this design permanently?')) return;
    await del('designs', id);
    if (window.sb && userId() && cloudOK) sb.from('studio_designs').delete().eq('id', id).then(() => { });
    if (A().doc().id === id) A().setDocId(null);
    openMyDesigns('designs');
  }

  // ------------------------------------------------------------------ Admin dashboard
  const ADMIN_SQL = `-- Run once in Supabase → SQL editor. Review before running.
alter table profiles add column if not exists is_admin boolean default false;
-- make yourself admin (replace the email):
-- update profiles set is_admin = true where email = 'you@example.com';

create or replace function is_studio_admin() returns boolean language sql stable security definer as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false) $$;

-- Design Studio cloud designs (per user)
create table if not exists studio_designs (
  id uuid primary key, user_id uuid references auth.users(id) on delete cascade,
  name text, width int, height int, thumb text, doc jsonb, updated_at timestamptz default now());
alter table studio_designs enable row level security;
drop policy if exists "own studio designs" on studio_designs;
create policy "own studio designs" on studio_designs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Admin-managed content
create table if not exists studio_templates (
  id uuid primary key default gen_random_uuid(), name text, cat text, premium boolean default false,
  tags text, thumb text, doc jsonb, created_at timestamptz default now());
create table if not exists studio_fonts (
  id uuid primary key default gen_random_uuid(), label text, css text, url text);
alter table studio_templates enable row level security;
alter table studio_fonts enable row level security;
drop policy if exists "read templates" on studio_templates;
create policy "read templates" on studio_templates for select using (auth.role() = 'authenticated');
drop policy if exists "admin templates" on studio_templates;
create policy "admin templates" on studio_templates for all using (is_studio_admin()) with check (is_studio_admin());
drop policy if exists "read fonts" on studio_fonts;
create policy "read fonts" on studio_fonts for select using (auth.role() = 'authenticated');
drop policy if exists "admin fonts" on studio_fonts;
create policy "admin fonts" on studio_fonts for all using (is_studio_admin()) with check (is_studio_admin());

-- Let admins manage users, settings, payments and graphics (adjust if you already have policies)
drop policy if exists "admin read profiles" on profiles;
create policy "admin read profiles" on profiles for select using (is_studio_admin());
drop policy if exists "admin update profiles" on profiles;
create policy "admin update profiles" on profiles for update using (is_studio_admin());
drop policy if exists "admin settings" on settings;
create policy "admin settings" on settings for all using (is_studio_admin()) with check (is_studio_admin());
drop policy if exists "admin read payments" on payments;
create policy "admin read payments" on payments for select using (is_studio_admin());
drop policy if exists "admin graphics" on store_assets;
create policy "admin graphics" on store_assets for all using (is_studio_admin()) with check (is_studio_admin());`;

  let adTab = 'overview';
  const ADMIN_TABS = [['overview', 'Overview'], ['users', 'Users'], ['templates', 'Templates'], ['graphics', 'Graphics'], ['fonts', 'Fonts'], ['pricing', 'Pricing & Settings'], ['payments', 'Payments'], ['setup', 'Setup SQL']];
  function openAdmin(tab) {
    if (!isAdmin()) { toast('Admin access only', true); return; }
    adTab = tab || adTab;
    dialog('Admin dashboard', `<div class="studio-chiprow">${ADMIN_TABS.map(([k, l]) => `<button class="studio-chip ${k === adTab ? 'active' : ''}" onclick="StudioStore.openAdmin('${k}')">${l}</button>`).join('')}</div><div id="studioAdBody"><p class="studio-hint">Loading…</p></div>`);
    (adminPanels[adTab] || (() => { }))(document.getElementById('studioAdBody'));
  }
  const errBox = (b, e) => { b.innerHTML = `<p class="studio-hint" style="color:var(--coral)">${esc(e.message || e)}<br>If this says a table or policy is missing, run the SQL in the “Setup SQL” tab.</p>`; };
  const adminPanels = {
    async overview(b) {
      try {
        const cnt = async (t, f) => { let q = sb.from(t).select('id', { count: 'exact', head: true }); if (f) q = f(q); const r = await q; return r.error ? '—' : r.count; };
        const [users, free, prem, biz, designs, tpl, dl] = await Promise.all([cnt('profiles'), cnt('profiles', q => q.eq('plan', 'free')), cnt('profiles', q => q.eq('plan', 'premium')), cnt('profiles', q => q.eq('plan', 'business')), cnt('studio_designs'), cnt('studio_templates'), cnt('downloads_log')]);
        b.innerHTML = `<div class="studio-hub">${[['👥', 'Users', users], ['🆓', 'Free plan', free], ['⭐', 'Premium', prem], ['🏢', 'Business', biz], ['🗂️', 'Studio designs (cloud)', designs], ['▣', 'Admin templates', tpl], ['⬇', 'Downloads logged', dl]].map(x => `<button style="cursor:default"><span>${x[0]}</span>${x[2]}<small>${x[1]}</small></button>`).join('')}</div>`;
      } catch (e) { errBox(b, e); }
    },
    async users(b) {
      const r = await sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(100); if (r.error) return errBox(b, r.error);
      b.innerHTML = `<table class="studio-table"><tr><th>User</th><th>Plan</th><th></th></tr>${r.data.map(u => `<tr><td>${esc(u.full_name || u.name || u.email || u.id.slice(0, 8))}<br><small style="color:var(--muted)">${esc(u.email || '')}</small></td><td><select onchange="StudioStore.setUser('${u.id}',{plan:this.value})">${['free', 'premium', 'business'].map(p => `<option ${u.plan === p ? 'selected' : ''}>${p}</option>`).join('')}</select></td><td><button onclick="StudioStore.setUser('${u.id}',{suspended:${!u.suspended}})">${u.suspended ? 'Unsuspend' : 'Suspend'}</button></td></tr>`).join('')}</table>`;
    },
    async templates(b) {
      const r = await sb.from('studio_templates').select('id,name,cat,premium,thumb').order('created_at', { ascending: false }); if (r.error) return errBox(b, r.error);
      b.innerHTML = `<div class="studio-form"><p class="studio-hint">Design something in the Studio, then add it here — it appears for all users in Templates.</p>
        <input type="text" id="adtName" placeholder="Template name" value="${esc(A().doc().name)}"><input type="text" id="adtCat" placeholder="Category (e.g. Offer Posters, Onam)" style="margin-top:6px"><input type="text" id="adtTags" placeholder="Search tags (comma separated)" style="margin-top:6px">
        <label style="display:block;margin-top:8px;font-size:12.5px"><input type="checkbox" id="adtPrem"> Premium only</label>
        <div class="studio-actions"><button class="btn btn-primary" onclick="StudioStore.addTemplate()">＋ Add current design as template</button></div></div>
        <table class="studio-table" style="margin-top:12px"><tr><th></th><th>Name</th><th>Premium</th><th></th></tr>${r.data.map(t => `<tr><td>${t.thumb ? `<img src="${t.thumb}" style="width:38px;border-radius:6px">` : ''}</td><td>${esc(t.name)}<br><small>${esc(t.cat || '')}</small></td><td><input type="checkbox" ${t.premium ? 'checked' : ''} onchange="StudioStore.tplPremium('${t.id}',this.checked)"></td><td><button onclick="StudioStore.tplDelete('${t.id}')">Delete</button></td></tr>`).join('')}</table>`;
    },
    async graphics(b) {
      const r = await sb.from('store_assets').select('*').limit(100); if (r.error) return errBox(b, r.error);
      b.innerHTML = `<div class="studio-form"><p class="studio-hint">Graphics/stickers shown to everyone in Elements → Admin graphics (shared with the poster editor).</p><input type="text" id="adgUrl" placeholder="Image URL (PNG with transparent background)"><div class="studio-actions"><button class="btn btn-primary" onclick="StudioStore.addGraphic()">＋ Add graphic</button></div></div>
        <div class="studio-grid" style="margin-top:10px">${r.data.map(g => `<div class="studio-cell bg" style="position:relative"><img src="${g.image_url}" style="width:100%;height:100%;object-fit:contain"><button style="position:absolute;top:2px;right:2px;border:none;border-radius:50%;width:22px;height:22px;background:rgba(0,0,0,.6);color:#fff;font-size:11px" onclick="StudioStore.delGraphic('${g.id}')">✕</button></div>`).join('')}</div>`;
    },
    async fonts(b) {
      const r = await sb.from('studio_fonts').select('*'); if (r.error) return errBox(b, r.error);
      b.innerHTML = `<div class="studio-form"><p class="studio-hint">Add a Google Font: paste its CSS link and the font-family name.</p><input type="text" id="adfLabel" placeholder="Display name (e.g. Chilanka)"><input type="text" id="adfCss" placeholder="CSS family (e.g. 'Chilanka',cursive)" style="margin-top:6px"><input type="text" id="adfUrl" placeholder="https://fonts.googleapis.com/css2?family=Chilanka&display=swap" style="margin-top:6px"><div class="studio-actions"><button class="btn btn-primary" onclick="StudioStore.addFont()">＋ Add font</button></div></div>
        <table class="studio-table" style="margin-top:10px">${r.data.map(f => `<tr><td>${esc(f.label)}</td><td><small>${esc(f.css)}</small></td><td><button onclick="StudioStore.delFont('${f.id}')">Delete</button></td></tr>`).join('')}</table>`;
    },
    async pricing(b) {
      const r = await sb.from('settings').select('*').eq('id', 1).single(); if (r.error) return errBox(b, r.error);
      const keys = Object.keys(r.data).filter(k => k !== 'id' && typeof r.data[k] !== 'object');
      b.innerHTML = `<p class="studio-hint">Edit values from the site settings row (prices, free limits, watermark text, payment settings). Changes apply to everyone. No payment is processed from here.</p><div class="studio-form">${keys.map(k => `<label class="studio-label">${esc(k)}</label><input type="text" data-k="${esc(k)}" value="${esc(r.data[k])}">`).join('')}</div><div class="studio-actions"><button class="btn btn-primary" onclick="StudioStore.saveSettings()">Save settings</button></div>`;
    },
    async payments(b) {
      const r = await sb.from('payments').select('*').order('created_at', { ascending: false }).limit(60); if (r.error) return errBox(b, r.error);
      const cols = r.data[0] ? Object.keys(r.data[0]).filter(k => !/signature|raw/i.test(k)).slice(0, 6) : [];
      b.innerHTML = r.data.length ? `<table class="studio-table"><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${r.data.map(p => `<tr>${cols.map(c => `<td>${esc(typeof p[c] === 'object' ? JSON.stringify(p[c]) : String(p[c]).slice(0, 28))}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="studio-empty-hint">No payments yet.</p>';
    },
    setup(b) { b.innerHTML = `<p class="studio-hint">Run this once in Supabase (SQL editor). It adds the admin flag, the Studio tables and Row Level Security so only admins can change content. Review it first — it assumes your existing tables are named profiles, settings, payments, store_assets.</p><textarea readonly style="width:100%;height:260px;font-size:11px;font-family:monospace">${esc(ADMIN_SQL)}</textarea><div class="studio-actions"><button class="btn btn-outline" onclick="navigator.clipboard.writeText(document.querySelector('#studioAdBody textarea').value).then(()=>toast('SQL copied'))">Copy SQL</button></div>`; }
  };
  const flash = async (p, ok) => { const r = await p; if (r.error) toast(r.error.message, true); else if (ok) toast(ok); return r; };
  async function setUser(id, patch) { await flash(sb.from('profiles').update(patch).eq('id', id), 'Updated'); }
  async function addTemplate() {
    const name = $('adtName'), doc = A().getDoc(); if (!name) return toast('Enter a name', true);
    const thumb = await thumbFromJSON(doc.pages[doc.pageIndex || 0], doc.width, doc.height, 320);
    const r = await flash(sb.from('studio_templates').insert({ name, cat: $('adtCat') || 'Custom', tags: $('adtTags'), premium: document.getElementById('adtPrem').checked, thumb, doc: { kind: doc.kind, mm: doc.mm, width: doc.width, height: doc.height, pageIndex: 0, pages: doc.pages } }), 'Template added');
    if (!r.error) { await loadAdminContent(); openAdmin('templates'); }
  }
  const $ = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  async function tplPremium(id, v) { await flash(sb.from('studio_templates').update({ premium: v }).eq('id', id), 'Updated'); loadAdminContent(); }
  async function tplDelete(id) { if (!confirm('Delete this template?')) return; await flash(sb.from('studio_templates').delete().eq('id', id), 'Deleted'); openAdmin('templates'); }
  async function addGraphic() { const u = $('adgUrl'); if (!/^https?:\/\//.test(u)) return toast('Enter an https image URL', true); const r = await flash(sb.from('store_assets').insert({ image_url: u }), 'Graphic added'); if (!r.error) { STATE.stickers.push(...(r.data || [])); openAdmin('graphics'); } }
  async function delGraphic(id) { await flash(sb.from('store_assets').delete().eq('id', id), 'Deleted'); STATE.stickers = STATE.stickers.filter(s => String(s.id) !== String(id)); openAdmin('graphics'); }
  async function addFont() { const label = $('adfLabel'), css = $('adfCss'), url = $('adfUrl'); if (!label || !css) return toast('Name and CSS family required', true); if (url && !/^https:\/\/fonts\.googleapis\.com\//.test(url)) return toast('Only Google Fonts links are allowed', true); const r = await flash(sb.from('studio_fonts').insert({ label, css, url }), 'Font added'); if (!r.error) { await loadAdminContent(); openAdmin('fonts'); } }
  async function delFont(id) { await flash(sb.from('studio_fonts').delete().eq('id', id), 'Deleted'); openAdmin('fonts'); }
  async function saveSettings() {
    const patch = {}; document.querySelectorAll('#studioAdBody [data-k]').forEach(i => { const v = i.value; patch[i.dataset.k] = v !== '' && !isNaN(v) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : (v === 'true' ? true : v === 'false' ? false : v); });
    const r = await flash(sb.from('settings').update(patch).eq('id', 1), 'Settings saved'); if (!r.error) Object.assign(STATE.settings, patch);
  }
  window.openStudioAdmin = () => { goto('studio'); setTimeout(() => openAdmin('overview'), 120); };

  return { autosave, saveNow, onEnterStudio, addUpload, useUpload, delUpload, beforeExport, afterExport, syncFavs, openMyDesigns, mdSearch, openDesign, dupDesign, renameDesign, delDesign, openAdmin, setUser, addTemplate, tplPremium, tplDelete, addGraphic, delGraphic, addFont, delFont, saveSettings, isAdmin, ADMIN_SQL, CONFIG, loadAdminContent };
})();


// ======================= video.js =======================
// ===================================================================================
// VIDEO MAKER (separate module, no AI). Photo/video slideshow with text overlays, simple
// animations, transitions and background music, rendered on a <canvas> and recorded in the
// browser with MediaRecorder. Output format depends on the browser: MP4 where the browser can
// record it (Safari, recent Chrome), otherwise WebM. Clip audio is not mixed (music track only). Colours / backgrounds are user-overridable per style.
// Runs entirely client-side; export happens in real time (a 20 s video takes ~20 s).
// ===================================================================================
var VideoMaker = (() => {
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s));
  const RATIOS = { '9:16': [720, 1280], '1:1': [1080, 1080], '16:9': [1280, 720], '4:5': [864, 1080] };
  const TRANS = [['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['none', 'Cut']];
  const ANIMS = [['fade', 'Fade in'], ['up', 'Slide up'], ['zoom', 'Zoom in'], ['pop', 'Pop'], ['left', 'Slide from left'], ['type', 'Typewriter'], ['none', 'None']];
  // Styles. Each style has its own colours + background decoration; the sample slide text comes from the
  // multilingual packs in studio-tpl.js, so every style can start in English, Malayalam, Tamil, Kannada or Hindi.
  const THEMES = {
    offer: { label: '🔥 Offer reel', cat: 'offer', bg: ['#B91C1C', '#F59E0B'], accent: '#FACC15', text: '#ffffff', deco: 'rays' },
    sale: { label: '🛍️ Big sale', cat: 'sale', bg: ['#0B1B3A', '#1E3A8A'], accent: '#38BDF8', text: '#ffffff', deco: 'stripes' },
    festival: { label: '🪔 Festival wishes', cat: 'festival', bg: ['#EA580C', '#FACC15'], accent: '#7C2D12', text: '#ffffff', deco: 'sparkle' },
    eid: { label: '🌙 Eid / Ramadan', cat: 'eid', bg: ['#064E3B', '#10B981'], accent: '#FDE68A', text: '#ffffff', deco: 'sparkle' },
    birthday: { label: '🎂 Birthday', cat: 'birthday', bg: ['#701A75', '#C026D3'], accent: '#FDE68A', text: '#ffffff', deco: 'dots' },
    wedding: { label: '💍 Wedding', cat: 'wedding', bg: ['#FBF6EA', '#F3E3C3'], accent: '#B8860B', text: '#3B2A10', deco: 'frame' },
    food: { label: '🍔 Food & restaurant', cat: 'food', bg: ['#B45309', '#EF4444'], accent: '#FDE047', text: '#ffffff', deco: 'dots' },
    jewellery: { label: '💎 Jewellery gold', cat: 'jewellery', bg: ['#1C1917', '#44403C'], accent: '#D4A537', text: '#FBF6EA', deco: 'frame' },
    education: { label: '🎓 Education', cat: 'education', bg: ['#0369A1', '#22D3EE'], accent: '#FDE047', text: '#ffffff', deco: 'circles' },
    realestate: { label: '🏠 Real estate', cat: 'realestate', bg: ['#14532D', '#65A30D'], accent: '#FDE047', text: '#ffffff', deco: 'stripes' },
    event: { label: '🎤 Event / concert', cat: 'event', bg: ['#4C1D95', '#DB2777'], accent: '#FDE68A', text: '#ffffff', deco: 'rays' },
    business: { label: '💼 Business', cat: 'business', bg: ['#0E6E5D', '#14B8A6'], accent: '#CC9A3C', text: '#ffffff', deco: 'circles' },
    fashion: { label: '👗 Fashion', cat: 'fashion', bg: ['#BE185D', '#FB7185'], accent: '#FEF08A', text: '#ffffff', deco: 'circles' },
    opening: { label: '🎊 Grand opening', cat: 'opening', bg: ['#4C1D95', '#2563EB'], accent: '#FACC15', text: '#ffffff', deco: 'sparkle' },
    neon: { label: '⚡ Neon night', cat: 'event', bg: ['#020617', '#312E81'], accent: '#22D3EE', text: '#ffffff', deco: 'neon' },
    clean: { label: '🤍 Clean light', cat: 'business', bg: ['#F8FAFC', '#E2E8F0'], accent: '#0E6E5D', text: '#0B1B3A', deco: 'circles' }
  };
  const LANG_LABEL = { en: 'English', ml: 'മലയാളം', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', hi: 'हिन्दी' };
  const slidesFor = (theme, lang) => {
    const pk = (StudioTpl.PACKS[lang] || StudioTpl.PACKS.en)[THEMES[theme].cat];
    return pk.inv ? [pk.head, pk.inv.names, pk.inv.line1, pk.inv.line2] : [pk.head, pk.tag, pk.sub, pk.cta];
  };
  const fontOf = () => (S.lang !== 'en' && StudioTpl.LF[S.lang] ? StudioTpl.LF[S.lang] + ',' : '') + "'Anton','Baloo Chettan 2','Noto Sans Malayalam',sans-serif";
  let S = null, raf = 0, playing = false, t0 = 0, recorder = null;

  const fresh = () => ({ ratio: '9:16', trans: 'fade', theme: 'offer', lang: 'en', slides: [], music: null, logo: null, tscale: 1, ov: {}, bgImg: null, vol: 0.8, brand: '', cur: 0, loop: false });
  const total = () => S.slides.reduce((a, s) => a + s.dur, 0);
  const dims = () => RATIOS[S.ratio];
  const plan = () => (window.STATE && STATE.profile && STATE.profile.plan) || 'free';
  const FREE_MAX_SEC = 20;
  // Background presets: [name, colour 1, colour 2, text colour, accent]
  const BG_PRESETS = [
    ['Ivory & gold', '#FBF6EA', '#F3E3C3', '#3B2A10', '#B8860B'], ['Royal maroon', '#4A0E1B', '#9B1C31', '#FBF6EA', '#E8C468'], ['Blush rose', '#FDE2E4', '#F8B4C0', '#5B1A2B', '#B76E79'],
    ['Temple gold', '#7A4A00', '#E0A526', '#FFFFFF', '#FFF2B3'], ['Emerald', '#064E3B', '#10B981', '#FFFFFF', '#FDE68A'], ['Midnight navy', '#0B1B3A', '#1E3A8A', '#FFFFFF', '#FACC15'],
    ['Sunset', '#7C2D12', '#F59E0B', '#FFFFFF', '#FEF08A'], ['Royal purple', '#2E1065', '#7C3AED', '#FFFFFF', '#FDE68A'], ['Ocean', '#0369A1', '#22D3EE', '#FFFFFF', '#FEF08A'],
    ['Peach cream', '#FFF1E6', '#FFD6BA', '#5A2A0C', '#C2410C'], ['Mint fresh', '#ECFDF5', '#A7F3D0', '#064E3B', '#047857'], ['Pure black', '#000000', '#1F1F1F', '#FFFFFF', '#FACC15'],
    ['Pure white', '#FFFFFF', '#F1F5F9', '#0F172A', '#0E6E5D'], ['Hot pink', '#BE185D', '#FB7185', '#FFFFFF', '#FEF08A'], ['Fire red', '#7F1D1D', '#EF4444', '#FFFFFF', '#FDE047'], ['Teal', '#0E6E5D', '#14B8A6', '#FFFFFF', '#CC9A3C']
  ];
  const DECOS = [['', 'Style default'], ['rays', 'Rays'], ['stripes', 'Stripes'], ['dots', 'Dots'], ['sparkle', 'Sparkles'], ['frame', 'Gold frame'], ['neon', 'Neon frame'], ['circles', 'Circles'], ['none', 'Plain']];
  const eff = () => Object.assign({}, THEMES[S.theme], S.ov || {});
  const lum = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return 1; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
  const isLight = h => lum(h) > 0.6;   // true = light text colour
  const hex6 = h => /^#[0-9a-f]{6}$/i.test(h) ? h : '#ffffff';

  function open() {
    if (!S) S = fresh();
    StudioTools.dlg('Video Maker', `
      <div class="studio-chiprow">${Object.keys(RATIOS).map(r => `<button class="studio-chip ${S.ratio === r ? 'active' : ''}" onclick="VideoMaker.setRatio('${r}')">${r}</button>`).join('')}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:0 0 auto;margin:0 auto"><canvas id="vmCanvas" style="background:#000;border-radius:10px;max-width:100%;max-height:300px"></canvas>
          <div class="studio-actions"><button class="btn btn-outline btn-sm" id="vmPlayBtn" onclick="VideoMaker.togglePlay()">▶ Preview</button><button class="btn btn-primary btn-sm" onclick="VideoMaker.exportVideo()">⬇ Export</button></div>
          <p class="studio-hint" id="vmInfo"></p></div>
        <div style="flex:1;min-width:220px" class="studio-form">
          <label class="studio-label">Style (${Object.keys(THEMES).length} styles)</label><select id="vmTheme" onchange="VideoMaker.setTheme(this.value)">${Object.entries(THEMES).map(([k, t]) => `<option value="${k}" ${S.theme === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select>
          <label class="studio-label">Background look (all styles incl. Wedding)</label><select onchange="VideoMaker.setPreset(this.value)"><option value="">Style default</option>${BG_PRESETS.map((p, i) => `<option value="${i}">${p[0]}</option>`).join('')}</select>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0">
            <label class="studio-hint">Bg 1 <input type="color" id="vmC0" value="${hex6(eff().bg[0])}" oninput="VideoMaker.setOv('c0',this.value)"></label>
            <label class="studio-hint">Bg 2 <input type="color" id="vmC1" value="${hex6(eff().bg[1])}" oninput="VideoMaker.setOv('c1',this.value)"></label>
            <label class="studio-hint">Text <input type="color" id="vmCT" value="${hex6(eff().text)}" oninput="VideoMaker.setOv('text',this.value)"></label>
            <label class="studio-hint">Accent <input type="color" id="vmCA" value="${hex6(eff().accent)}" oninput="VideoMaker.setOv('accent',this.value)"></label>
            <button class="btn btn-outline btn-sm" onclick="VideoMaker.resetOv()">Reset</button></div>
          <label class="studio-label">Decoration</label><select onchange="VideoMaker.setOv('deco',this.value)">${DECOS.map(d => `<option value="${d[0]}" ${(S.ov.deco || '') === d[0] ? 'selected' : ''}>${d[1]}</option>`).join('')}</select>
          <label class="studio-label">Background photo (optional, for text slides)</label><input type="file" accept="image/*" onchange="VideoMaker.setBgImage(this)"><div class="studio-hint">${S.bgImg ? 'Photo set — <a href="#" onclick="VideoMaker.clearBgImage();return false">remove</a>' : 'None'}</div>
          <label class="studio-label">Language of sample text</label><select onchange="VideoMaker.setLang(this.value)">${Object.entries(LANG_LABEL).map(([k, l]) => `<option value="${k}" ${S.lang === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <label class="studio-label">Text size (all slides): <b id="vmTs">${Math.round(S.tscale * 100)}%</b></label><input type="range" min="0.5" max="2" step="0.05" value="${S.tscale}" oninput="VideoMaker.setTextScale(this.value)">
          <label class="studio-label">Time for every slide (seconds)</label><div style="display:flex;gap:6px"><input type="number" id="vmAllDur" min="1" max="60" step="0.5" value="3" style="width:80px"><button class="btn btn-outline btn-sm" onclick="VideoMaker.setAllDur()">Apply to all</button></div>
          <label class="studio-label">Logo overlay on the whole video (optional)</label><input type="file" accept="image/*" onchange="VideoMaker.setLogo(this)">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0"><select onchange="VideoMaker.setLogoOpt('pos',this.value)">${[['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['c', 'Centre']].map(o => `<option value="${o[0]}" ${(S.logo && S.logo.pos) === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
            <label class="studio-hint">Size <input type="range" min="5" max="60" step="1" value="${S.logo ? S.logo.size : 18}" oninput="VideoMaker.setLogoOpt('size',+this.value)"></label>
            <label class="studio-hint">Opacity <input type="range" min="0.2" max="1" step="0.05" value="${S.logo ? S.logo.alpha : 1}" oninput="VideoMaker.setLogoOpt('alpha',+this.value)"></label>
            <button class="btn btn-outline btn-sm" onclick="VideoMaker.clearLogo()">${S.logo ? 'Remove logo' : ''}</button></div>
          <label class="studio-label">Transition</label><select onchange="VideoMaker.setTrans(this.value)">${TRANS.map(t => `<option value="${t[0]}" ${S.trans === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}</select>
          <label class="studio-label">Brand / watermark text (optional)</label><input type="text" value="${esc(S.brand)}" oninput="VideoMaker.setBrand(this.value)" placeholder="Your shop name">
          <label class="studio-label">Music (optional)</label><input type="file" accept="audio/*" onchange="VideoMaker.setMusic(this)"><div id="vmMusic" class="studio-hint">${S.music ? esc(S.music.name) : 'No music'}</div>
          <label class="studio-hint">Music volume <input type="range" min="0" max="1" step="0.05" value="${S.vol}" oninput="VideoMaker.setVol(this.value)"></label>
          <label class="studio-label">Add photos / video clips</label><input type="file" accept="image/*,video/*" multiple onchange="VideoMaker.addFiles(this)">
          <div class="studio-actions"><button class="btn btn-outline btn-sm" onclick="VideoMaker.addTextSlide()">＋ Text slide</button><button class="btn btn-outline btn-sm" onclick="VideoMaker.fromTheme()">Fill text slides from style</button></div>
        </div></div>
      <label class="studio-label">Slides</label><div id="vmSlides"></div>
      <div class="studio-actions"><button class="btn btn-outline" onclick="VideoMaker.close()">Close</button></div>`);
    renderSlides(); sizeCanvas(); if (!S.slides.length) fromTheme(); else draw(0);
  }
  function close() { stop(); StudioTools.closeDlg(); }
  function sizeCanvas() {
    const c = document.getElementById('vmCanvas'); if (!c) return; const [w, h] = dims(); c.width = w; c.height = h;
    const k = Math.min(300 / h, 320 / w, 1); c.style.width = Math.round(w * k) + 'px'; c.style.height = Math.round(h * k) + 'px';
  }
  function setRatio(r) { stop(); S.ratio = r; open(); }
  function setTrans(v) { S.trans = v; }
  function setBrand(v) { S.brand = v; }
  function setLogo(input) { const f = input.files && input.files[0]; if (!f) return; const im = new Image(); im.onload = () => { S.logo = { el: im, pos: 'tr', size: 18, alpha: 1 }; open(); }; im.src = URL.createObjectURL(f); }
  function setLogoOpt(k, v) { if (!S.logo) return; S.logo[k] = v; draw(S.slides.length ? startOf(S.cur) + 0.9 : 0); }
  function clearLogo() { S.logo = null; open(); }
  async function setPhoto2(i, input) { const f = input.files && input.files[0]; if (!f) return; const im = new Image(); im.src = URL.createObjectURL(f); await new Promise(r => { im.onload = r; im.onerror = r; }); S.slides[i].el2 = im; S.slides[i].src2 = im.src; renderSlides(); draw(startOf(i) + 0.9); }
  function setTextScale(v) { S.tscale = parseFloat(v) || 1; const e = document.getElementById('vmTs'); if (e) e.textContent = Math.round(S.tscale * 100) + '%'; draw(S.slides.length ? startOf(S.cur) + 0.9 : 0); }
  function setAllDur() { const v = Math.min(60, Math.max(1, parseFloat(document.getElementById('vmAllDur').value) || 3)); S.slides.forEach(s => { if (s.type !== 'video') s.dur = v; }); renderSlides(); draw(0); }
  function setTheme(v) { S.theme = v; S.ov = {}; refreshColors(); if (S.slides.every(x => x.type === 'text')) fromTheme(); else draw(0); }
  function refreshColors() { const e = eff(), set = (id, v) => { const el = document.getElementById(id); if (el) el.value = hex6(v); }; set('vmC0', e.bg[0]); set('vmC1', e.bg[1]); set('vmCT', e.text); set('vmCA', e.accent); }
  function setOv(k, v) {
    if (k === 'c0') S.ov.bg = [v, eff().bg[1]]; else if (k === 'c1') S.ov.bg = [eff().bg[0], v];
    else if (v === '') delete S.ov[k]; else S.ov[k] = v;
    draw(S.slides.length ? startOf(S.cur) + 0.9 : 0);
  }
  function setPreset(i) { if (i === '') { delete S.ov.bg; delete S.ov.text; delete S.ov.accent; } else { const p = BG_PRESETS[+i]; S.ov.bg = [p[1], p[2]]; S.ov.text = p[3]; S.ov.accent = p[4]; } refreshColors(); draw(startOf(S.cur) + 0.9); }
  function resetOv() { S.ov = {}; S.bgImg = null; open(); }
  function setBgImage(input) { const f = input.files && input.files[0]; if (!f) return; const im = new Image(); im.onload = () => { S.bgImg = im; open(); }; im.src = URL.createObjectURL(f); }
  function clearBgImage() { S.bgImg = null; open(); }
  function setVol(v) { S.vol = parseFloat(v); if (S.music && S.music.el) S.music.el.volume = S.vol; }
  function setLang(v) { S.lang = v; if (S.slides.every(x => x.type === 'text')) fromTheme(); else draw(0); }

  // ------------------------------------------------------------------ slides
  const mk = o => Object.assign({ type: 'text', dur: 3, text: '', anim: 'fade', pos: 'bottom', el: null, src: '', name: '', layout: 'full', el2: null, src2: '', ov: '#000000', ova: 0 }, o);
  async function fromTheme() {
    const texts = slidesFor(S.theme, S.lang); await ensureVidFonts(texts.join(' '));
    S.slides = texts.map((t, i) => mk({ type: 'text', text: t, dur: i === 0 ? 3 : 2.5, anim: ['pop', 'fade', 'up', 'zoom'][i % 4], pos: 'center' }));
    renderSlides(); draw(0);
  }
  async function ensureVidFonts(sample) { if (!document.fonts || !document.fonts.load) return; const fam = fontOf().split(',').filter(x => x.includes("'") || x.includes('Baloo')).slice(0, 3); try { await Promise.race([Promise.all(fam.map(f => document.fonts.load('800 40px ' + f.trim(), sample))), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* ignore */ } }
  function addTextSlide() { S.slides.push(mk({ type: 'text', text: 'Your text', dur: 2.5, anim: 'fade', pos: 'center' })); renderSlides(); }
  async function addFiles(input) {
    for (const f of Array.from(input.files || [])) {
      const url = URL.createObjectURL(f);
      if (f.type.startsWith('video/')) {
        const v = document.createElement('video'); v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
        await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; });
        S.slides.push(mk({ type: 'video', el: v, src: url, name: f.name, dur: Math.min(8, Math.max(2, Math.round(v.duration || 4))), text: '', pos: 'bottom' }));
      } else {
        const im = new Image(); im.src = url; await new Promise(r => { im.onload = r; im.onerror = r; });
        S.slides.push(mk({ type: 'image', el: im, src: url, name: f.name, dur: 3, text: '', anim: 'fade', pos: 'bottom' }));
      }
    }
    input.value = ''; renderSlides(); draw(0);
  }
  function setMusic(input) {
    const f = input.files && input.files[0]; if (!f) return;
    const a = new Audio(URL.createObjectURL(f)); a.loop = true; a.crossOrigin = 'anonymous';
    S.music = { name: f.name, el: a, file: f }; document.getElementById('vmMusic').textContent = f.name;
  }
  function renderSlides() {
    const box = document.getElementById('vmSlides'); if (!box) return;
    box.innerHTML = S.slides.map((s, i) => `<div style="display:flex;gap:6px;align-items:center;padding:8px;border:1.5px solid var(--line);border-radius:10px;margin-bottom:6px;background:var(--cream);flex-wrap:wrap">
      <div style="width:44px;height:44px;border-radius:8px;background:#222;overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px">${s.type === 'image' ? `<img src="${s.src}" style="width:100%;height:100%;object-fit:cover">` : s.type === 'video' ? '🎞️' : 'T'}</div>
      <input type="text" style="flex:1;min-width:110px;padding:7px;border:1.5px solid var(--line);border-radius:8px;font-size:12.5px" placeholder="Text on this slide" value="${esc(s.text)}" oninput="VideoMaker.upd(${i},'text',this.value)">
      <select style="padding:6px;border-radius:8px;border:1.5px solid var(--line);font-size:12px" onchange="VideoMaker.upd(${i},'anim',this.value)">${ANIMS.map(a => `<option value="${a[0]}" ${s.anim === a[0] ? 'selected' : ''}>${a[1]}</option>`).join('')}</select>
      <input type="color" value="${hex6(s.tc || (s.type === 'text' ? eff().text : '#ffffff'))}" title="Text colour of this slide" style="width:34px;height:30px;padding:0;border:1.5px solid var(--line);border-radius:8px" oninput="VideoMaker.upd(${i},'tc',this.value)">
      <select style="padding:6px;border-radius:8px;border:1.5px solid var(--line);font-size:12px" onchange="VideoMaker.upd(${i},'pos',this.value)">${['top', 'center', 'bottom'].map(p => `<option ${s.pos === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <label title="Text size of this slide" style="font-size:11px;display:flex;align-items:center;gap:3px">A<input type="range" min="0.5" max="2.5" step="0.05" value="${s.sz || 1}" style="width:70px" oninput="VideoMaker.upd(${i},'sz',parseFloat(this.value))">A</label>
      <label title="Seconds this slide is shown" style="font-size:11px;display:flex;align-items:center;gap:3px"><input type="number" min="1" max="60" step="0.5" value="${s.dur}" style="width:58px;padding:6px;border-radius:8px;border:1.5px solid var(--line);font-size:12px" onchange="VideoMaker.upd(${i},'dur',Math.min(60,Math.max(1,parseFloat(this.value)||3)))">s</label>
      <button class="icon-btn" onclick="VideoMaker.move(${i},-1)">↑</button><button class="icon-btn" onclick="VideoMaker.move(${i},1)">↓</button><button class="icon-btn" onclick="VideoMaker.del(${i})">🗑</button>
      <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px">
        ${s.type === 'image' ? `<label>Layout <select onchange="VideoMaker.upd(${i},'layout',this.value);VideoMaker.renderSlides()" style="padding:5px;border-radius:8px;border:1.5px solid var(--line)"><option value="full" ${s.layout === 'full' ? 'selected' : ''}>Full photo</option><option value="lr" ${s.layout === 'lr' ? 'selected' : ''}>Split — left | right</option><option value="tb" ${s.layout === 'tb' ? 'selected' : ''}>Split — top / bottom</option></select></label>` + (s.layout !== 'full' ? `<label>2nd photo <input type="file" accept="image/*" onchange="VideoMaker.setPhoto2(${i},this)" style="max-width:150px">${s.el2 ? ' ✓' : ' (needed)'}</label>` : '') : ''}
        <label>Overlay <input type="color" value="${hex6(s.ov)}" oninput="VideoMaker.upd(${i},'ov',this.value)" style="width:30px;height:26px;padding:0"> <input type="range" min="0" max="0.9" step="0.05" value="${s.ova || 0}" style="width:80px" oninput="VideoMaker.upd(${i},'ova',parseFloat(this.value))" title="Overlay strength (0 = none)"></label>
      </div></div>`).join('') || '<p class="studio-empty-hint">Add photos, clips or text slides.</p>';
    const info = document.getElementById('vmInfo'); if (info) info.textContent = `${S.slides.length} slides · ${total().toFixed(1)} s` + (plan() === 'free' ? ` · Free plan: ${FREE_MAX_SEC}s max + watermark` : '');
  }
  function upd(i, k, v) { S.slides[i][k] = v; if (k === 'dur') renderSlides(); draw(startOf(i) + 0.9); }
  function move(i, d) { const j = i + d; if (j < 0 || j >= S.slides.length) return; [S.slides[i], S.slides[j]] = [S.slides[j], S.slides[i]]; renderSlides(); }
  function del(i) { S.slides.splice(i, 1); renderSlides(); draw(0); }
  const startOf = i => S.slides.slice(0, i).reduce((a, s) => a + s.dur, 0);

  // ------------------------------------------------------------------ rendering
  const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
  function wrap(ctx, text, maxW) {
    const out = []; String(text).split('\n').forEach(par => { let line = ''; par.split(/\s+/).forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }); out.push(line); }); return out;
  }
  function drawIn(ctx, el, x, y, w, h, zoom) { ctx.save(); ctx.translate(x, y); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip(); drawCover(ctx, el, w, h, zoom, 0, 0); ctx.restore(); }
  function drawCover(ctx, el, W, H, zoom, ox, oy) {
    const iw = el.videoWidth || el.naturalWidth || el.width, ih = el.videoHeight || el.naturalHeight || el.height; if (!iw || !ih) return;
    const s = Math.max(W / iw, H / ih) * zoom, w = iw * s, h = ih * s; ctx.drawImage(el, (W - w) / 2 + ox, (H - h) / 2 + oy, w, h);
  }
  function deco(ctx, th, W, H, t) {
    const u = Math.min(W, H), dark = isLight(th.text) ? 0.12 : 0.1; ctx.save();
    const lightFill = isLight(th.text) ? 'rgba(255,255,255,' : 'rgba(0,0,0,';
    if (th.deco === 'none') { ctx.restore(); return; }
    if (th.deco === 'rays') { ctx.translate(W / 2, H * 0.45); ctx.rotate(t * 0.15); ctx.fillStyle = lightFill + '0.10)'; for (let i = 0; i < 24; i += 2) { const a1 = i / 24 * 6.2832, a2 = (i + 1) / 24 * 6.2832, R = Math.hypot(W, H); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a1) * R, Math.sin(a1) * R); ctx.lineTo(Math.cos(a2) * R, Math.sin(a2) * R); ctx.fill(); } }
    else if (th.deco === 'stripes') { ctx.fillStyle = lightFill + '0.07)'; ctx.translate(0, 0); const off = (t * 40) % (u * 0.2); for (let x = -H; x < W + H; x += u * 0.2) { ctx.save(); ctx.translate(x + off, 0); ctx.rotate(0.45); ctx.fillRect(0, -H, u * 0.08, H * 3); ctx.restore(); } }
    else if (th.deco === 'dots') { ctx.fillStyle = lightFill + '0.12)'; for (let i = 0; i < 26; i++) { const x = ((i * 137.5) % 100) / 100 * W, y = (((i * 61.8) + t * 12) % 100) / 100 * H; ctx.beginPath(); ctx.arc(x, y, u * (0.01 + (i % 4) * 0.008), 0, 7); ctx.fill(); } }
    else if (th.deco === 'sparkle') { ctx.fillStyle = th.accent; for (let i = 0; i < 18; i++) { const x = ((i * 97.3) % 100) / 100 * W, y = ((i * 53.7) % 100) / 100 * H, k = 0.5 + 0.5 * Math.sin(t * 3 + i), r = u * 0.018 * (0.4 + k); ctx.globalAlpha = 0.25 + 0.5 * k; ctx.beginPath(); ctx.moveTo(x, y - r * 2); ctx.lineTo(x + r * 0.5, y - r * 0.5); ctx.lineTo(x + r * 2, y); ctx.lineTo(x + r * 0.5, y + r * 0.5); ctx.lineTo(x, y + r * 2); ctx.lineTo(x - r * 0.5, y + r * 0.5); ctx.lineTo(x - r * 2, y); ctx.lineTo(x - r * 0.5, y - r * 0.5); ctx.closePath(); ctx.fill(); } }
    else if (th.deco === 'frame') { ctx.strokeStyle = th.accent; ctx.lineWidth = u * 0.008; const m = u * 0.05; ctx.strokeRect(m, m, W - m * 2, H - m * 2); ctx.lineWidth = u * 0.003; ctx.strokeRect(m * 1.5, m * 1.5, W - m * 3, H - m * 3); }
    else if (th.deco === 'neon') { ctx.strokeStyle = th.accent; ctx.shadowColor = th.accent; ctx.shadowBlur = u * 0.04; ctx.lineWidth = u * 0.006; const m = u * 0.06, r = u * 0.05; ctx.beginPath(); ctx.moveTo(m + r, m); ctx.arcTo(W - m, m, W - m, H - m, r); ctx.arcTo(W - m, H - m, m, H - m, r); ctx.arcTo(m, H - m, m, m, r); ctx.arcTo(m, m, W - m, m, r); ctx.closePath(); ctx.stroke(); }
    else { ctx.fillStyle = lightFill + (dark > 0.11 ? '0.08)' : '0.06)'); ctx.beginPath(); ctx.arc(W * 0.85 + Math.sin(t) * u * 0.02, H * 0.15, u * 0.35, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(W * 0.1, H * 0.9 + Math.cos(t) * u * 0.02, u * 0.3, 0, 7); ctx.fill(); }
    ctx.restore();
  }
  function drawSlide(ctx, s, lt, W, H, tr) { // lt = local time; tr = {kind, p, dir} for the incoming slide
    const th = eff(), u = Math.min(W, H);
    ctx.save();
    if (tr) {
      if (tr.kind === 'fade') ctx.globalAlpha = tr.p;
      else if (tr.kind === 'slide') ctx.translate((1 - tr.p) * W, 0);
      else if (tr.kind === 'zoom') { ctx.globalAlpha = tr.p; ctx.translate(W / 2, H / 2); const z = 0.85 + 0.15 * tr.p; ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); }
    }
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    const kb = 1 + 0.08 * Math.min(1, lt / Math.max(0.5, s.dur)); // slow Ken-Burns zoom
    if (s.type === 'image' && s.layout !== 'full' && s.el2) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); const g = Math.max(4, Math.round(u * 0.008));
      if (s.layout === 'lr') { drawIn(ctx, s.el, 0, 0, W / 2 - g / 2, H, kb); drawIn(ctx, s.el2, W / 2 + g / 2, 0, W / 2 - g / 2, H, kb); ctx.fillStyle = th.accent; ctx.fillRect(W / 2 - g / 2, 0, g, H); }
      else { drawIn(ctx, s.el, 0, 0, W, H / 2 - g / 2, kb); drawIn(ctx, s.el2, 0, H / 2 + g / 2, W, H / 2 - g / 2, kb); ctx.fillStyle = th.accent; ctx.fillRect(0, H / 2 - g / 2, W, g); }
    }
    else if (s.type === 'image') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); drawCover(ctx, s.el, W, H, kb, 0, 0); }
    else if (s.type === 'video') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); drawCover(ctx, s.el, W, H, 1, 0, 0); }
    else { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, th.bg[0]); g.addColorStop(1, th.bg[1]); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); if (S.bgImg) { drawCover(ctx, S.bgImg, W, H, kb, 0, 0); ctx.fillStyle = isLight(th.text) ? 'rgba(0,0,0,.38)' : 'rgba(255,255,255,.45)'; ctx.fillRect(0, 0, W, H); } deco(ctx, th, W, H, lt); }
    if (s.ova > 0) { ctx.save(); ctx.globalAlpha *= s.ova; ctx.fillStyle = s.ov || '#000000'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (s.text) {
      if (s.type !== 'text') { const gr = ctx.createLinearGradient(0, H * 0.5, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.55)'); ctx.fillStyle = gr; ctx.fillRect(0, H * 0.5, W, H * 0.5); }
      const p = ease(lt / 0.7); let txt = s.text, alpha = 1, dy = 0, dx = 0, sc = 1;
      if (s.anim === 'fade') alpha = p; else if (s.anim === 'up') { alpha = p; dy = (1 - p) * u * 0.08; } else if (s.anim === 'zoom') { alpha = p; sc = 0.6 + 0.4 * p; } else if (s.anim === 'pop') { const q = Math.min(1, lt / 0.6), o = 1.70158; alpha = Math.min(1, lt / 0.25); sc = 1 + (o + 1) * Math.pow(q - 1, 3) + o * Math.pow(q - 1, 2); sc = Math.max(0.01, sc); } else if (s.anim === 'left') { alpha = p; dx = -(1 - p) * W * 0.5; } else if (s.anim === 'type') txt = s.text.slice(0, Math.ceil(s.text.length * Math.min(1, lt / Math.max(0.8, s.dur * 0.6))));
      const size = Math.round(u * (s.type === 'text' ? 0.085 : 0.06) * (S.tscale || 1) * (s.sz || 1)); ctx.font = `800 ${size}px ${fontOf()}`;
      const lines = wrap(ctx, txt, W * 0.84), lh = size * 1.18, bh = lines.length * lh, cy = s.pos === 'top' ? H * 0.18 : s.pos === 'center' ? H * 0.5 : H * 0.82 - bh / 2;
      ctx.globalAlpha *= alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.translate(W / 2 + dx, cy + dy); ctx.scale(sc, sc);
      const tcol = s.tc || (s.type === 'text' ? th.text : '#ffffff'), light = isLight(tcol);
      ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.14; ctx.strokeStyle = light ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)'; ctx.fillStyle = tcol;
      lines.forEach((l, k) => { const y = (k - (lines.length - 1) / 2) * lh; ctx.strokeText(l, 0, y); ctx.fillText(l, 0, y); });
    }
    ctx.restore();
  }
  function draw(t, forExport) {
    const c = document.getElementById('vmCanvas'); if (!c || !S.slides.length) { if (c) { const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, c.width, c.height); } return null; }
    const ctx = c.getContext('2d'), W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
    let acc = 0, idx = 0; for (let i = 0; i < S.slides.length; i++) { if (t < acc + S.slides[i].dur || i === S.slides.length - 1) { idx = i; break; } acc += S.slides[i].dur; }
    const s = S.slides[idx], lt = Math.min(s.dur, Math.max(0, t - acc)), trD = S.trans === 'none' ? 0 : 0.6;
    S.cur = idx;
    if (s.type === 'video') syncVideo(s, lt);
    // outgoing/incoming: draw previous slide underneath during the first trD seconds
    if (idx > 0 && trD && lt < trD) { const prev = S.slides[idx - 1]; drawSlide(ctx, prev, prev.dur, W, H, null); drawSlide(ctx, s, lt, W, H, { kind: S.trans, p: ease(lt / trD) }); }
    else drawSlide(ctx, s, lt, W, H, null);
    if (S.logo && S.logo.el && (S.logo.el.naturalWidth || S.logo.el.width)) {
      const L = S.logo, u2 = Math.min(W, H), lw = u2 * L.size / 100, lh = lw * (L.el.naturalHeight || L.el.height) / (L.el.naturalWidth || L.el.width), m = u2 * 0.04;
      const x = L.pos === 'c' ? (W - lw) / 2 : (L.pos.endsWith('l') ? m : W - lw - m), y = L.pos === 'c' ? (H - lh) / 2 : (L.pos.startsWith('t') ? m : H - lh - m);
      ctx.save(); ctx.globalAlpha = L.alpha; ctx.drawImage(L.el, x, y, lw, lh); ctx.restore();
    }
    if (S.brand || plan() === 'free') {
      const txt = S.brand || '', wm = plan() === 'free' ? ((window.STATE && STATE.settings && STATE.settings.watermark_text) || 'OFFER POSTER STUDIO') : '';
      ctx.save(); ctx.font = `800 ${Math.round(Math.min(W, H) * 0.03)}px 'Manrope',sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      if (txt) { ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 6; ctx.fillText(txt, W - W * 0.04, H * 0.04); }
      if (wm) { ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText(wm, W - W * 0.04, H * 0.97); }
      ctx.restore();
    }
    return idx;
  }
  const vidState = new WeakMap();
  function syncVideo(s, lt) {
    const v = s.el; if (!v) return;
    if (playing) { if (v.paused) { try { v.currentTime = 0; } catch (e) { /* ignore */ } v.play().catch(() => { }); } }
    else if (Math.abs(v.currentTime - lt) > 0.3) { try { v.currentTime = lt; } catch (e) { /* ignore */ } }
  }

  // ------------------------------------------------------------------ playback
  function togglePlay() { playing ? stop() : play(); }
  function play(onEnd, rec) {
    if (!S.slides.length) return toast('Add some slides first', true);
    stop(); playing = true; t0 = performance.now(); const btn = document.getElementById('vmPlayBtn'); if (btn) btn.textContent = '⏸ Stop';
    if (S.music && !rec) { S.music.el.currentTime = 0; S.music.el.volume = S.vol; S.music.el.play().catch(() => { }); }
    S.slides.forEach(s => { if (s.type === 'video') { s.el.pause(); } });
    const limit = effectiveTotal();
    const tick = now => {
      if (!playing) return; const t = (now - t0) / 1000;
      if (t >= limit) { stop(); draw(limit - 0.01); if (onEnd) onEnd(); return; }
      draw(t); raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    playing = false; cancelAnimationFrame(raf); if (S) { if (S.music) S.music.el.pause(); S.slides.forEach(s => { if (s.type === 'video' && s.el) s.el.pause(); }); }
    const btn = document.getElementById('vmPlayBtn'); if (btn) btn.textContent = '▶ Preview';
  }
  const effectiveTotal = () => plan() === 'free' ? Math.min(total(), FREE_MAX_SEC) : total();

  // ------------------------------------------------------------------ export (MediaRecorder)
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const m of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ } }
    return null;
  }
  async function exportVideo() {
    if (!S.slides.length) return toast('Add some slides first', true);
    let actxEarly = null; if (S.music && S.music.file) { try { actxEarly = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* ignore */ } }
    const c = document.getElementById('vmCanvas'), mime = pickMime();
    if (!c.captureStream || !mime) return toast('This browser cannot record video. Try Chrome or Safari.', true);
    if (total() > FREE_MAX_SEC && plan() === 'free') toast(`Free plan exports the first ${FREE_MAX_SEC} seconds — upgrade for full length`);
    if (window.StudioStore) { const gate = { format: 'video', multiplier: 1, transparent: false, print: false }; if (!(await StudioStore.beforeExport(gate))) { if (actxEarly) try { actxEarly.close(); } catch (e) { /* ignore */ } return; } }
    stop();
    const stream = c.captureStream(30); let actx = null, srcNode = null;
    if (S.music && S.music.file) {
      // Decode the file and feed it to the recorder through a fresh buffer source (reliable; no element re-routing).
      try {
        actx = actxEarly || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') await actx.resume();
        const buf = await actx.decodeAudioData(await S.music.file.arrayBuffer());
        const dst = actx.createMediaStreamDestination(), gain = actx.createGain(); gain.gain.value = S.vol;
        srcNode = actx.createBufferSource(); srcNode.buffer = buf; srcNode.loop = true; srcNode.connect(gain); gain.connect(dst);
        const tracks = dst.stream.getAudioTracks(); if (!tracks.length) throw new Error('no audio track'); tracks.forEach(tk => stream.addTrack(tk));
      } catch (e) { console.warn('music not captured', e); srcNode = null; toast('Could not read this music file — exporting without music (try an MP3 or M4A)', true); }
    }
    const chunks = []; recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { recorder.onstop = r; });
    toast('Recording… keep this window open'); recorder.start(250); if (srcNode) { try { srcNode.start(0); } catch (e) { /* ignore */ } }
    play(() => { setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 300); }, true);
    await done;
    if (srcNode) { try { srcNode.stop(); } catch (e) { /* ignore */ } } if (actx) { try { actx.close(); } catch (e) { /* ignore */ } }
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm', blob = new Blob(chunks, { type: mime.split(';')[0] }), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `video_${Date.now()}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (window.StudioStore) StudioStore.afterExport({ format: 'video', multiplier: 1, name: 'Video', w: c.width, h: c.height });
    toast(ext === 'mp4' ? 'Video exported (MP4)' : 'Video exported as WebM (this browser cannot record MP4)');
  }

  return { renderSlides, setLogo, setLogoOpt, clearLogo, setPhoto2, setTextScale, setAllDur, setOv, setPreset, resetOv, setBgImage, clearBgImage, setVol, open, close, setRatio, setTrans, setBrand, setTheme, setLang, setMusic, addFiles, addTextSlide, fromTheme, upd, move, del, togglePlay, exportVideo, THEMES, pickMime };
})();

