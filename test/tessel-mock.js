var util = require("util");
var Emitter = require("events").EventEmitter;
var Duplex = require("stream").Duplex;
var net = require("net");

function Tessel() {
  if (Tessel.instance) {
    return Tessel.instance;
  } else {
    Tessel.instance = this;
  }
  this.ports = {
    A: new Tessel.Port("A", "/var/run/tessel/port_a", this),
    B: new Tessel.Port("B", "/var/run/tessel/port_b", this)
  };
  this.port = this.ports;

  this.led = new Tessel.LEDs([{
    color: "red",
    type: "error"
  }, {
    color: "amber",
    type: "wlan"
  }, {
    color: "green",
    type: "user1"
  }, {
    color: "blue",
    type: "user2"
  }, ]);

  this.leds = this.led;

  this.network = {
    wifi: new Tessel.Wifi(),
    ap: new Tessel.AP()
  };
}

Tessel.prototype.pwmFrequency = function(frequency, cb) {};

Tessel.Port = function(name, socketPath, board) {
  var port = this;

  this.name = name;
  this.board = board;
  // Connection to the SPI daemon
  this.sock = {
    cork: function() {},
    uncork: function() {},
    write: function() {}
  };

  // Active peripheral: "none", "i2c", "spi", "uart"
  this.mode = "none";

  // Array of {size, callback} used to dispatch replies
  this.replyQueue = [];
  this.pin = [];

  for (var i = 0; i < 8; i++) {
    var adcSupported = name === "B" || [4, 7].indexOf(i) !== -1 ? true : false;
    this.pin.push(
      new Tessel.Pin(i, this, [2, 5, 6, 7].indexOf(i) !== -1, adcSupported)
    );
  }

  this.pwm = [];


  this.I2C = function(addr, mode) {
    return new Tessel.I2C({
      addr: addr,
      mode: mode,
      port: port
    });
  };

  this.SPI = function(format) {
    if (!this.spi) {
      this.spi = new Tessel.SPI(format === null ? {} : format, port);
    }
    return this.spi;
  };

  this.UART = function(format) {
    if (!this.uart) {
      this.uart = new Tessel.UART(port, format || {});
    }
    return this.uart;
  };

};

Tessel.Port.prototype.ref = function() {};

Tessel.Port.prototype.unref = function() {};

Tessel.Port.prototype.enqueue = function(reply) {};

Tessel.Port.prototype.dequeue = function() {};

Tessel.Port.prototype.cork = function() {
  this.sock.cork();
};

Tessel.Port.prototype.uncork = function() {
  this.sock.uncork();
};

Tessel.Port.prototype.sync = function(cb) {
  if (cb) {
    this.sock.write(new Buffer([CMD.ECHO, 1, 0x88]));
    this.replyQueue.push({
      size: 1,
      callback: function(err, data) {
        cb(null);
      }
    });
  }
};

Tessel.Port.prototype.command = function(buf, cb) {
  this.cork();
  this.sock.write(new Buffer(buf));
  this.sync(cb);
  this.uncork();
};

Tessel.Port.prototype.status_cmd = function(buf, cb) {
  this.sock.write(new Buffer(buf));
  this.replyQueue.push({
    size: 0,
    callback: cb,
  });
};

Tessel.Port.prototype.tx = function(buf, cb) {
  if (buf.length === 0) {
    throw new Error("Length must be non-zero");
  } else if (buf.length > 255) {
    // TODO: split into sequence of commands
    throw new Error("Buffer size must be less than 255");
  }

  this.cork();
  this.sock.write(new Buffer([CMD.TX, buf.length]));
  this.sock.write(buf);
  this.sync(cb);
  this.uncork();
};

Tessel.Port.prototype.rx = function(len, cb) {
  if (len === 0) {
    throw new Error("Length must be non-zero");
  } else if (len > 255) {
    // TODO: split into sequence of commands
    throw new Error("Buffer size must be less than 255");
  }

  this.sock.write(new Buffer([CMD.RX, len]));
  this.replyQueue.push({
    size: len,
    callback: cb,
  });
};

Tessel.Port.prototype.txrx = function(buf, cb) {
  if (buf.length === 0) {
    throw new Error("Length must be non-zero");
  } else if (buf.length > 255) {
    // TODO: split into sequence of commands
    throw new Error("Buffer size must be less than 255");
  }

  this.cork();
  this.sock.write(new Buffer([CMD.TXRX, buf.length]));
  this.sock.write(buf);
  this.replyQueue.push({
    size: buf.length,
    callback: cb,
  });
  this.uncork();
};


Tessel.Pin = function(pin, port, interruptSupported, analogSupported) {
  this.pin = pin;
  this.port = port;
  this.interruptSupported = interruptSupported || false;
  this.analogSupported = analogSupported || false;
  this.interruptMode = null;
  this.isPWM = false;
};

util.inherits(Tessel.Pin, Emitter);

Tessel.Pin.interruptModes = {
  "rise": 1,
  "fall": 2,
  "change": 3,
  "high": 4,
  "low": 5,
};

Tessel.Pin.prototype.removeListener = function(event, listener) {
  // If it"s an interrupt event, remove as necessary
  var emitter = Tessel.Pin.super_.prototype.removeListener.apply(this, arguments);

  if (event === this.interruptMode && Emitter.listenerCount(this, event)) {
    this.setInterruptMode(null);
  }

  return emitter;
};

Tessel.Pin.prototype.removeAllListeners = function(event) {
  if (!event || event === this.interruptMode) {
    this.setInterruptMode(null);
  }

  return Tessel.Pin.super_.prototype.removeAllListeners.apply(this, arguments);
};

Tessel.Pin.prototype.addListener = function(mode, callback) {
  if (mode in Tessel.Pin.interruptModes) {
    if (!this.interruptSupported) {
      throw new Error("Interrupts are not supported on pin " + this.pin);
    }

    if ((mode === "high" || mode === "low") && !callback.listener) {
      throw new Error("Cannot use 'on' with level interrupts. You can only use 'once'.");
    }

    if (this.interruptMode !== mode) {
      if (this.interruptMode) {
        throw new Error("Can't set pin interrupt mode to " + mode + "; already listening for " + this.interruptMode);
      }
      this.setInterruptMode(mode);
    }
  }

  // Add the event listener
  Tessel.Pin.super_.prototype.on.call(this, mode, callback);
};
Tessel.Pin.prototype.on = Tessel.Pin.prototype.addListener;

Tessel.Pin.prototype.setInterruptMode = function(mode) {
  this.interruptMode = mode;
  var bits = mode ? Tessel.Pin.interruptModes[mode] << 4 : 0;
  this.port.command([CMD.GPIO_INT, this.pin | bits]);
};

Tessel.Pin.prototype.high = function(cb) {
  this.port.command([CMD.GPIO_HIGH, this.pin], cb);
  return this;
};

Tessel.Pin.prototype.low = function(cb) {
  this.port.command([CMD.GPIO_LOW, this.pin], cb);
  return this;
};

// Deprecated. Added for tessel 1 lib compat
Tessel.Pin.prototype.rawWrite = function(value) {
  if (value) {
    this.high();
  } else {
    this.low();
  }
  return this;
};

Tessel.Pin.prototype.toggle = function(cb) {
  this.port.command([CMD.GPIO_TOGGLE, this.pin], cb);
  return this;
};

Tessel.Pin.prototype.output = function output(initialValue, cb) {
  if (initialValue) {
    this.high(cb);
  } else {
    this.low(cb);
  }
  return this;
};

Tessel.Pin.prototype.write = function(value, cb) {
  // same as .output
  return this.output(value, cb);
};

Tessel.Pin.prototype.rawDirection = function(isOutput, cb) {
  throw new Error("Tessel.Pin.rawDirection is deprecated. Use Tessel.Pin.input or .output instead.");
};

Tessel.Pin.prototype.readPin = function(cmd, cb) {
  this.port.cork();
  this.port.sock.write(new Buffer([cmd, this.pin]));
  this.port.replyQueue.push({
    size: 0,
    callback: function(err, data) {
      cb(err, data === REPLY.HIGH ? 1 : 0);
    },
  });
  this.port.uncork();
};

Tessel.Pin.prototype.rawRead = function rawRead(cb) {
  this.readPin(CMD.GPIO_RAW_READ, cb);
  return this;
};

Tessel.Pin.prototype.input = function input(cb) {
  this.port.command([CMD.GPIO_INPUT, this.pin], cb);
  return this;
};

Tessel.Pin.prototype.read = function(cb) {
  this.readPin(CMD.GPIO_IN, cb);
  return this;
};

Tessel.Pin.prototype.readPulse = function(type, timeout, callback) {
  throw new Error("Tessel.Pin.readPulse is not yet implemented");
};

Tessel.Pin.prototype.resolution = 4096;

Tessel.Pin.prototype.pwmDutyCycle = function(duty, callback) {};

Tessel.Pin.prototype.pull = function(mode, callback) {};

Tessel.Pin.prototype.analogRead = function(cb) {
  return this;
};

Tessel.Pin.prototype.analogWrite = function(val) {
  return this;
};

Tessel.I2C = function(params, port) {
  this.addr = params.addr;
  this.port = params.port;
  this.port.command([CMD.ENABLE_I2C, this.baud]);
};

Tessel.I2C.prototype.send = function(data, callback) {
  this.port.cork();
  this.port.command([CMD.START, this.addr << 1]);
  this.port.tx(data);
  this.port.command([CMD.STOP], callback);
  this.port.uncork();
};

Tessel.I2C.prototype.read = function(length, callback) {
  this.port.cork();
  this.port.command([CMD.START, this.addr << 1 | 1]);
  this.port.rx(length, callback);
  this.port.command([CMD.STOP]);
  this.port.uncork();
};

Tessel.I2C.prototype.transfer = function(txbuf, rxlen, callback) {
  this.port.cork();
  if (txbuf.length > 0) {
    this.port.command([CMD.START, this.addr << 1]);
    this.port.tx(txbuf);
  }
  this.port.command([CMD.START, this.addr << 1 | 1]);
  this.port.rx(rxlen, callback);
  this.port.command([CMD.STOP]);
  this.port.uncork();
};

Tessel.SPI = function(params, port) {
  this.port = port;
  // default to pin 5 of the module port as cs
  this.chipSelect = params.chipSelect || this.port.digital[0];

  this.chipSelectActive = params.chipSelectActive === "high" || params.chipSelectActive === 1 ? 1 : 0;

  if (this.chipSelectActive) {
    // active high, pull low for now
    this.chipSelect.low();
  } else {
    // active low, pull high for now
    this.chipSelect.high();
  }

  /* spi baud rate is set by the following equation:
   *  f_baud = f_ref/(2*(baud_reg+1))
   *  max baud rate is 24MHz for the SAMD21, min baud rate is 93750 without a clock divisor
   *  with a max clock divisor of 255, slowest clock is 368Hz unless we switch from 48MHz xtal to 32KHz xtal
   */
  // default is 2MHz
  params.clockSpeed = params.clockSpeed ? params.clockSpeed : 2e6;

  // if speed is slower than 93750 then we need a clock divisor
  if (params.clockSpeed > 24e6 || params.clockSpeed < 368) {
    throw new Error("SPI Clock needs to be between 24e6 and 368Hz.");
  }

  this.clockReg = Math.floor(48e6 / (2 * params.clockSpeed) - 1);

  // find the smallest clock divider such that clockReg is <=255
  if (this.clockReg > 255) {
    // find the clock divider, make sure its at least 1
    this.clockDiv = Math.floor(48e6 / (params.clockSpeed * (2 * 255 + 2))) || 1;

    // if the speed is still too low, set the clock divider to max and set baud accordingly
    if (this.clockDiv > 255) {
      this.clockReg = Math.floor(this.clockReg / 255) || 1;
      this.clockDiv = 255;
    } else {
      // if we can set a clock divider <255, max out clockReg
      this.clockReg = 255;
    }
  } else {
    this.clockDiv = 1;
  }

  if (typeof params.dataMode === "number") {
    params.cpol = params.dataMode & 0x1;
    params.cpha = params.dataMode & 0x2;
  }

  this.cpol = params.cpol === "high" || params.cpol === 1 ? 1 : 0;
  this.cpha = params.cpha === "second" || params.cpha === 1 ? 1 : 0;

  this.port.command([CMD.ENABLE_SPI, this.cpol + (this.cpha << 1), this.clockReg, this.clockDiv]);
};

Tessel.SPI.prototype.send = function(data, callback) {
  this.port.cork();
  this.chipSelect.low();
  this.port.tx(data, callback);
  this.chipSelect.high();
  this.port.uncork();
};

Tessel.SPI.prototype.deinit = function() {
  this.port.command([CMD.CMD_DISABLE_SPI]);
};

Tessel.SPI.prototype.receive = function(length, callback) {
  this.port.cork();
  this.chipSelect.low();
  this.port.rx(length, callback);
  this.chipSelect.high();
  this.port.uncork();
};

Tessel.SPI.prototype.transfer = function(data, callback) {
  this.port.cork();
  this.chipSelect.low();
  this.port.txrx(data, callback);
  this.chipSelect.high();
  this.port.uncork();
};

Tessel.UART = function(port, options) {
  Duplex.call(this, {});

  this.port = port;

  // baud is given by the following:
  // baud = 65536*(1-(samples_per_bit)*(f_wanted/f_ref))
  // samples_per_bit = 16, 8, or 3
  // f_ref = 48e6
  this.baudrate = options.baudrate || 9600;
  // make sure baudrate is in between 9600 and 115200
  if (this.baudrate < 9600 || this.baudrate > 115200) {
    throw new Error("UART baudrate must be between 9600 and 115200");
  }
  this.baud = Math.floor(65536 * (1 - 16 * (this.baudrate / 48e6)));

  // split _baud up into two bytes & send
  this.port.command([CMD.ENABLE_UART, this.baud >> 8, this.baud & 0xFF]);

  this.enabled = true;
};

util.inherits(Tessel.UART, Duplex);

Tessel.UART.prototype.write = function(chunk, encoding, cb) {
  // throw an error if not enabled
  if (!this.enabled) {
    throw new Error("UART is not enabled on this port");
  }
  this.port.tx(chunk, cb);
};

Tessel.UART.prototype.read = function() {};

Tessel.UART.prototype.disable = function() {
  this.port.command([CMD.DISABLE_UART, 0, 0]);
  this.enabled = false;
};

var CMD = {
  NOP: 0,
  FLUSH: 1,
  ECHO: 2,
  GPIO_IN: 3,
  GPIO_HIGH: 4,
  GPIO_LOW: 5,
  GPIO_TOGGLE: 21,
  GPIO_CFG: 6,
  GPIO_WAIT: 7,
  GPIO_INT: 8,
  GPIO_INPUT: 22,
  GPIO_RAW_READ: 23,
  ANALOG_READ: 24,
  ANALOG_WRITE: 25,
  ENABLE_SPI: 10,
  DISABLE_SPI: 11,
  ENABLE_I2C: 12,
  DISABLE_I2C: 13,
  ENABLE_UART: 14,
  DISABLE_UART: 15,
  TX: 16,
  RX: 17,
  TXRX: 18,
  START: 19,
  STOP: 20,
  PWM_DUTY_CYCLE: 27,
  PWM_PERIOD: 28,
};

var REPLY = {
  ACK: 0x80,
  NACK: 0x81,
  HIGH: 0x82,
  LOW: 0x83,
  DATA: 0x84,

  MIN_ASYNC: 0xA0,
  ASYNC_PIN_CHANGE_N: 0xC0, // c0 to c8 is all async pin assignments
  ASYNC_UART_RX: 0xD0
};

var SPISettings = {
  CPOL: 1,
  CPHA: 2
};


var prefix = "/sys/devices/leds/leds/tessel:";
var suffix = "/brightness";

Tessel.LEDs = function(defs) {
  var descriptors = {};
  var leds = [];

  defs.forEach(function(definition, index) {
    var name = definition.color + ":" + definition.type;
    var path = prefix + name + suffix;
    var color = definition.color;
    descriptors[index] = {
      get: function() {
        // On first access of any built-
        // in LED...
        if (leds[index] === undefined) {
          // The LED object must be initialized
          leds[index] = new Tessel.LED(color, path);
          // And set to 0
          leds[index].low();
        }
        return leds[index];
      }
    };
  }, this);

  descriptors.length = {
    value: 4
  };

  Object.defineProperties(this, descriptors);
};

["on", "off", "toggle"].forEach(function(operation) {
  Tessel.LEDs.prototype[operation] = function() {
    return this;
  };
});

Tessel.LED = function(color, path) {
  var state = {
    color: color,
    path: path,
    value: 0,
  };

  // Define data properties that enforce
  // write privileges.
  Object.defineProperties(this, {
    color: {
      value: state.color
    },
    path: {
      value: state.path
    },
    value: {
      get: function() {
        return state.value;
      },
      set: function(value) {
        // Treat any truthiness as "high"
        state.value = value ? 1 : 0;
      }
    },
    isOn: {
      get: function() {
        return state.value === 1;
      }
    }
  });
};

Tessel.LED.prototype.high = function(callback) {
  this.write(true, callback);
};

Tessel.LED.prototype.low = function(callback) {
  this.write(false, callback);
};

Tessel.LED.prototype.write = function(value, callback) {
  if (typeof callback !== "function") {
    callback = function() {};
  }

  this.value = value;
};

Tessel.Wifi = function() {};
Tessel.AP = function() {};

if (process.env.IS_TEST_MODE) {
  // To make this module testable, we need
  // control over the creation of every
  // Tessel instance.

  var exportable = function() {
    return new Tessel();
  };

  exportable.CMD = CMD;
  exportable.REPLY = REPLY;
  exportable.Tessel = Tessel;
  /*
  // Implied...
  exportable.Tessel.LED = LED;
  exportable.Tessel.I2C = I2C;
  exportable.Tessel.Pin = Pin;
  exportable.Tessel.Port = Port;
  exportable.Tessel.SPI = SPI;
  exportable.Tessel.Tessel = Tessel;
  exportable.Tessel.UART = UART;
  */

  module.exports = exportable;
} else {
  module.exports = new Tessel();
}
