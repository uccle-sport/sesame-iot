const io = require("socket.io-client");
const exec=require('child_process').exec;
const token = process.argv[2]
const uuid = process.argv[3]
const server = process.argv[4] || 'wss://server.com/'
const gpioPath = process.argv[5] || '/usr/bin/gpio'
const autoCloseDelay = parseInt(process.argv[6] || '3')

const socket = io(server, { autoConnect: false, query:  {token, uuid}});

let isClosed = true
let isClosing = false
let isOpening = false
let latestKeepOpen = 0
const events = []

const simulate = gpioPath === 'none'
let simulationStatus = 'closed'
let simulationTimeout = 0

const setSimulationStatus = (newStatus) => {
    console.log('Simulation status', newStatus)
    simulationStatus = newStatus
}

const gpio = simulate ? (cmd, cb) => {
        console.log('GPIO: '+cmd)
        if (cmd.startsWith('read 7')) {
            console.log('->  '+(simulationStatus === 'closed' ? '0' : '1'))
            cb(undefined, simulationStatus === 'closed' ? '0' : '1')
        }
        if (cmd.startsWith('write 25 0')) {
            if (simulationStatus === 'closed' || simulationStatus === 'willOpen') {
                simulationTimeout = setTimeout(() => {
                    setSimulationStatus('open')
                }, 22000)
                setTimeout(() => {
                    setSimulationStatus('opening')
                }, 2000)
            } else if (simulationStatus === 'open' || simulationStatus === 'willClose') {
                simulationTimeout = setTimeout(() => {
                    setSimulationStatus('closed')
                }, 22000)
                setTimeout(() => {
                    setSimulationStatus('closing')
                }, 2000)
            } else if (simulationStatus === 'opening') {
                setSimulationStatus('willClose')
                clearTimeout(simulationTimeout)
            } else if (simulationStatus === 'closing') {
                setSimulationStatus('willOpen')
                clearTimeout(simulationTimeout)
            }
        }
    } : (cmd, cb) => exec(`${gpioPath} ${cmd}`, cb)

gpio('write 25 1')
gpio('mode 25 output')

let toggling = false
const toggleGarageDoor = () => {
    gpio('write 25 0')
    setTimeout(() => {
        gpio('write 25 1')
        setTimeout(() => { toggling = false }, 2200)
    }, 800)
}

const close = () => {
    isClosing = true
    notify()
    setTimeout(() => { isClosing = false }, 28000)
    toggleGarageDoor()
}

const open = () => {
    isOpening = true
    notify()
    setTimeout(() => { isOpening = false; notify() }, 24000)
    toggleGarageDoor()
}

const notify = () => {
    console.log(`Notify { closed: ${isClosed}, open: ${!isClosed && !isClosing && !isOpening}, opening: ${isOpening}, closing: ${isClosing}`)
    socket.emit('notify', {token, uuid, msg: { closed: isClosed, open: !isClosed && !isClosing && !isOpening, opening: isOpening, closing: isClosing}})
}

const scanStatus = () => {
        gpio('read 7', (error, stdout, stderr) => {
        if (error) {
            console.error(`Scan error: ${error}`);
            return;
        }
        //console.log(`Scanned: ${stdout}`)
        const closed = !stdout.match(/.*1.*/) //1 means open, 0 means closed
        if (closed && isClosed || (!closed) && (!isClosed)) {
            //Nothing changed
        } else {
            if (closed) {
                events.push({type:'closeEvent', date:+new Date()})
                console.log("Detected close")
                isClosed = true
                isClosing = false
                notify()
            } else {
                events.push({type:'openEvent', date:+new Date()})
                console.log("Detected open")
                isClosed = false
                notify()
            }
        }
    })
}

const autoClose = () => {
    const now = +new Date();
    if (!isClosed && !isClosing && !toggling) {
        console.log("Auto close ?")
        if (latestKeepOpen < now) {
            if (events.length === 0) {
                events.push({type: 'openEvent', date: now})
            } else {
                const ev = events[events.length - 1]
                if (ev.date + autoCloseDelay * 60 * 1000 < now) {
                    close()
                } else {
                    console.log(`Open for less than ${autoCloseDelay} minutes`)
                }
            }
        } else {
            console.log(`Canceled because must keep open until ${latestKeepOpen}, currently ${now}`)
        }
    }
}
console.log("Initialised")

socket.on("connect_error", (err) => {
    console.error(`connect_error due to ${err.message}`);
});

socket.on('connect', () => {
    console.log("Connected")
})

socket.on('open', (msg, callback) => {
    console.log("Open")
    if (toggling) {
        callback({status:'busy'})
    } else if (isClosing || isOpening) {
        callback({status:isClosing?'closing':'opening'})
    } else if (!isClosed) {
        callback({status:'no-change'})
    } else {
        callback({status:'ok'})
        open()
    }
});

socket.on('close', (msg, callback) => {
    console.log("Close")
    if (toggling) {
        callback({status:'busy'})
    } else if (isClosing || isOpening) {
        callback({status:isClosing?'closing':'opening'})
    } else if (isClosed) {
        callback({status:'no-change'})
    } else {
        callback({status:'ok'})
        close()
    }
});

socket.on('keepOpen', (msg, callback) => {
    const duration = Math.min(msg.duration || 300000, 4 * 60 * 60000)
    console.log(`keepOpen for ${duration} with msg:`, msg)
    latestKeepOpen = +new Date() + duration
    callback({status:'ok'})
});

socket.on('ping', (msg, callback) => {
    callback({ closed: isClosed, open: !isClosed && !isClosing && !isOpening, closing: isClosing, opening: isOpening, events: events.slice(Math.max(events.length - 10, 0))})
});

setInterval(() => scanStatus(), 1000)
setInterval(() => autoClose(), 5000)

socket.connect()
console.log("Started")
