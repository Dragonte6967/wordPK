import { createApp } from 'vue'
if(location.pathname==='/admin'||location.pathname.startsWith('/admin/')){
  await import('./admin.css')
  const {default:Admin}=await import('./Admin.vue')
  createApp(Admin).mount('#app')
}else{
  await import('./style.css')
  await import('./mobile.css')
  await import('./features.css')
  const {default:App}=await import('./App.vue')
  createApp(App).mount('#app')
}
