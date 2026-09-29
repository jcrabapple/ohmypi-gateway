import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/base.css';
import './styles/prose.css';
import './styles/components.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
