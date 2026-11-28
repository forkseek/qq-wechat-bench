// 打开动画最先引入：样式和开关都打包进 /app/assets（后台只认这个目录，CSP 也不许内联）
import './boot/boot.css';
import './boot/boot.js';
import { createApp } from 'vue';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.vue';

createApp(App).mount('#app');

// 告诉打开动画（boot/boot.js）应用已经挂好，可以把那页「日历纸」撕走了
window.__xunkeReady = true;
window.dispatchEvent(new Event('xunke:ready'));
