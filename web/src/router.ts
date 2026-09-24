import { createRouter, createWebHistory } from 'vue-router'
import { authSession } from './auth-session'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/language-practice' },
    {
      path: '/login',
      name: 'login',
      component: () => import('./features/auth/LoginView.vue'),
    },
    {
      path: '/language-practice',
      name: 'language-practice',
      component: () => import('./features/language-practice/LanguagePracticeSetupView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/language-practice/sessions/:sessionId',
      name: 'language-practice-session',
      component: () => import('./features/language-practice/LivePracticeView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/language-practice/sessions/:sessionId/complete',
      name: 'language-practice-completion',
      component: () => import('./features/language-practice/PracticeReportView.vue'),
      meta: { requiresAuth: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/language-practice' },
  ],
})

router.beforeEach(async (to) => {
  const checkingLogoutResult = to.name === 'login' && to.query.logout === 'unconfirmed'
  const result = await authSession.refresh()

  if (to.meta.requiresAuth) {
    if (result === 'authenticated') return true
    return { name: 'login', query: result === 'unavailable' ? { status: 'unavailable' } : undefined }
  }

  if (to.name === 'login' && result === 'authenticated' && !checkingLogoutResult) {
    return { name: 'language-practice' }
  }
  return true
})
