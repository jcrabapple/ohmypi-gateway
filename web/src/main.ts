import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/base.css';
import './styles/prose.css';
import './styles/components.css';
import App from './App.svelte';
import { registerOverlays } from './components/register';
import { registerServiceWorker } from './lib/pwa/register';

registerOverlays();

mount(App, { target: document.getElementById('app')! });
registerServiceWorker();
