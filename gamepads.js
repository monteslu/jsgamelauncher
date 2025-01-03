import sdl from '@kmamal/sdl';

const { controller, joystick } = sdl;

// knulli doesn't want me to log to console.log for some reason
// console.log = console.error;

let gamepads = [];

if (!globalThis.navigator) {
  globalThis.navigator = {};
}
globalThis.navigator.getGamepads = () => {
  // console.log('get gamepads');
  return gamepads;
};

// translates from SDL2 gamepad controller button/axes names to browser standard gamepad button/axes indices
const stdGamepadMapping = {
  'a': 0, // south btn
  'b': 1, // east btn
  'x': 2, // west btn
  'y': 3, // north btn
  'leftShoulder': 4,
  'rightShoulder': 5,
  'leftTrigger': 6,
  'rightTrigger': 7,
  'back': 8, // select
  'start': 9,
  'leftStick': 10,
  'rightStick': 11,
  'dpadUp': 12,
  'dpadDown': 13,
  'dpadLeft': 14,
  'dpadRight': 15,
  'guide': 16,
  'leftStickX': 0,
  'leftStickY': 1,
  'rightStickX': 2,
  'rightStickY': 3,
  'leftTrigger': 4,
  'rightTrigger': 5,
};

// deeplay (RG35XXSP) joystick to browser standard gamepad button indices
const deeplayJSMap = [
  100, // sdl_idx 0 , ?
  100, // sdl_idx 1 , ?
  100, // sdl_idx 2 , ?
  1, // sdl_idx 3 , b
  0, // sdl_idx 4 , a
  2, // sdl_idx 5 , x
  3, // sdl_idx 6 , y
  4, // sdl_idx 7 , left shoulder
  5, // sdl_idx 8 , right shoulder
  8, // sdl_idx 9 , select
  9, // sdl_idx 10 , start
  16, // sdl_idx 11 , guide
  6, // sdl_idx 12 , left trigger
  7, // sdl_idx 13 , right trigger
  16, // sdl_idx 14 , guide again?
];

// anbernic (RG40XXH) joystick to browser standard gamepad button indices
const anbernicJSMap = [
  100, // sdl_idx 0 , ?
  100, // sdl_idx 1 , ?
  100, // sdl_idx 2 , ?
  1, // sdl_idx 3 , b
  0, // sdl_idx 4 , a
  2, // sdl_idx 5 , x
  3, // sdl_idx 6 , y
  4, // sdl_idx 7 , left shoulder
  5, // sdl_idx 8 , right shoulder
  8, // sdl_idx 9 , select
  9, // sdl_idx 10 , start
  16, // sdl_idx 11 , guide
  10, // sdl_idx 12 , left joystick (L3)
  6, // sdl_idx 13 , left trigger
  7, // sdl_idx 14 , right trigger
  11, // sdl_idx 15 , right joystick (R3)
];


// translate SDL2 std joystick button ids to browser standard gamepad button indices
const stdJoystickMapping = [
  0, // sdl_idx 0 , a
  1, // sdl_idx 1 , b
  2, // sdl_idx 2 , x
  3, // sdl_idx 3 , y
  8, // sdl_idx 4 , back
  16, // sdl_idx 5 , guide
  9, // sdl_idx 6 , start
  10, // sdl_idx 7 , left stick
  11, // sdl_idx 8 , right stick
  4, // sdl_idx 9 , left shoulder
  5, // sdl_idx 10 , right shoulder
  12, // sdl_idx 11 , dpad up
  13, // sdl_idx 12 , dpad down
  14, // sdl_idx 13 , dpad left
  15, // sdl_idx 14 , dpad right
];



function createGamepad(device, _sdltype) {
  let _jsMap = stdJoystickMapping;
  const lcDev = String(device.name).toLowerCase();
  if (lcDev.startsWith('anbernic ') || ['deeplay-keys'].includes(lcDev)) {
    _jsMap = deeplayJSMap;
  } else if (lcDev.startsWith('anbernic-keys')) {
    _jsMap = anbernicJSMap;
  }
  return {
    id: device.name,
    index: device._index,
    guid: device.guid,
    mapping: 'standard',
    axes: Array(6).fill(0),
    buttons: Array(17).fill(0).map(() => {
      return {pressed: false, value: 0}
    }),
    _sdltype,
    _jsMap,
  }
}

function addController(device) {
  let exists = false;
  gamepads.forEach((gp) => {
    if (gp.guid === device.guid) {
      exists = true;
      console.log('controller already exists', device);
    }
  });
  if (!exists) {
    console.log('adding controller', device, joystick.devices.length);
    const gp = createGamepad(device, 'controller');
    console.log('opening controller', device);
    const instance = controller.openDevice(device);
    console.log('controller instance open', instance);
    instance.on('*', (type, e) => {
      // console.log('controller event', type, e);
      if (type === 'buttonDown') {
        if (stdGamepadMapping[e.button] !== undefined) {
          const btn = gp.buttons[stdGamepadMapping[e.button]];
          btn.pressed = true;
          btn.value = 1;
        }
      } else if (type === 'buttonUp') {
        if (stdGamepadMapping[e.button] !== undefined) {
          const btn = gp.buttons[stdGamepadMapping[e.button]];
          btn.pressed = false;
          btn.value = 0;
        }
      } else if (type === 'axisMotion') {
        if (stdGamepadMapping[e.axis] !== undefined) {
          gp.axes[stdGamepadMapping[e.axis]] = e.value;
        }
        if (e.axis === 'leftTrigger') {
          gp.buttons[6].value = e.value;
          gp.buttons[6].pressed = e.value > 0.11;
        } else if (e.axis === 'rightTrigger') {
          gp.buttons[7].value = e.value;
          gp.buttons[7].pressed = e.value > 0.11;
        }
      }
      // console.log('gamepad', gp);
    });
    gamepads.push(gp);
  }
  
}

function addJoystick(device) {
  let exists = false;
  gamepads.forEach((gp) => {
    if (gp.guid === device.guid) {
      exists = true;
      console.log('joystick already exists', device);
    }
  });
  if (!exists) {
    console.log('adding joystick', device, joystick.devices.length);
    const gp = createGamepad(device, 'joystick');
    console.log('opening joystick', device);
    const instance = joystick.openDevice(device);
    console.log('joystick instance open', instance);
    instance.on('*', (type, e) => {
      // console.log('JOYSTICK event', type, e);
      if (type === 'buttonDown') {
        if (gp._jsMap[e.button] !== undefined) {
          // console.log('button down', e.button, gp._jsMap[e.button]);
          const btn = gp.buttons[gp._jsMap[e.button]];
          if (btn) {
            btn.pressed = true;
            btn.value = 1;
          }
        }
      } else if (type === 'buttonUp') {
        if (gp._jsMap[e.button] !== undefined) {
          // console.log('button up', e.button, gp._jsMap[e.button]);
          const btn = gp.buttons[gp._jsMap[e.button]];
          if (btn) {
            btn.pressed = false;
            btn.value = 0;
          }
        }
      } else if (type === 'axisMotion') {
        gp.axes[e.axis] = e.value;
        if (e.axis === 4) {
          let val = (e.value + 1) / 2;
          gp.buttons[6].value = val;
          gp.buttons[6].pressed = val > 0.11;
        } else if (e.axis === 5) {
          let val = (e.value + 1) / 2;
          gp.buttons[7].value = val;
          gp.buttons[7].pressed = val > 0.11;
        }
      } else if (type === 'hatMotion' && e.hat === 0) {
        if (e.value === 'up') {
          gp.buttons[12].pressed = true;
          gp.buttons[12].value = 1;
        } else if (e.value === 'down') {
          gp.buttons[13].pressed = true;
          gp.buttons[13].value = 1;
        } else if (e.value === 'left') {
          gp.buttons[14].pressed = true;
          gp.buttons[14].value = 1;
        } else if (e.value === 'right') {
          gp.buttons[15].pressed = true;
          gp.buttons[15].value = 1;
        } else if (e.value === 'centered') {
          gp.buttons[12].pressed = false;
          gp.buttons[12].value = 0;
          gp.buttons[13].pressed = false;
          gp.buttons[13].value = 0;
          gp.buttons[14].pressed = false;
          gp.buttons[14].value = 0;
          gp.buttons[15].pressed = false;
          gp.buttons[15].value = 0;
        }
      }
    });
    gamepads.push(gp);
  }
}

export function initGamepads() {
  sdl.controller.on('deviceAdd', (e) => {
    console.log('deviceAdd controller', e);
    addController(e.device);
  });
  sdl.joystick.on('deviceAdd', (e) => {
    console.log('deviceAdd joystick', e);
    addJoystick(e.device);
  });
  
  function removeController(device) {
    console.log('deviceRemove controller', device, controller.devices.length);
    const newGamepads = [];
    gamepads.forEach((gp) => {
      if (gp.guid !== device.guid) {
        newGamepads.push(gp);
      }
    });
    gamepads = newGamepads;
  }
  function removeJoystick(device) {
    console.log('deviceRemove joystick', device, joystick.devices.length);
    const newGamepads = [];
    gamepads.forEach((gp) => {
      if (gp.guid !== device.guid) {
        newGamepads.push(gp);
      }
    });
    gamepads = newGamepads;
  }
  sdl.joystick.on('deviceRemove', removeJoystick);
  sdl.controller.on('deviceRemove', removeController);
  
  controller.devices.forEach(addController);
  joystick.devices.forEach(addJoystick);
  
}

