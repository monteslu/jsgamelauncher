import { initGamepads } from '../gamepads.js';

initGamepads();

const [p1, p2] = navigator.getGamepads();

console.log(p1, p2);

