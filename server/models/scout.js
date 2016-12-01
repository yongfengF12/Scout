const fetch = require('isomorphic-fetch')
const vm = require('vm')
const assert = require('assert')
const arrayToHeaders = require('../utils/arrayToHeaders')
const mongoose = require('./db')
const getSettings = require('./getSettings')

const { floor } = Math
const ScoutSchema = new mongoose.Schema({
  name: { type: String, required: true },
  tags: [String],
  method: {
    type: String,
    uppercase: true,
    enum: ['GET', 'HEAD', 'POST'],
    default: 'GET',
  },
  URL: { type: String, required: true },
  body: String,
  recipients: [String],

  headers: [[String]],
  ApdexTarget: { type: Number, default: 500, min: 100, get: floor, set: floor },
  interval: { type: Number, default: 5, min: 1, get: floor, set: floor },
  _nextTime: { type: Number, default: 0 },
  tolerance: { type: Number, default: 0, min: 0, get: floor, set: floor },
  _errors: { type: Number, default: 0 },

  readType: { type: String, enum: ['text', 'json'], default: 'text' },
  testCase: String,

  snapshots: [{
    timestamp: { type: Date, default: Date.now },
    status: { type: 'String', enum: ['OK', 'Error', 'Idle'] },
    statusCode: Number,
    responseTime: Number,
    errMessage: String,
    body: String,
  }],
  workTime: [[[Number]]],
})

ScoutSchema.methods = {
  patrol() {
    if (this._nextTime > 0) {
      this._nextTime -= 1
      this.save()
      return
    }
    this._nextTime = this.interval - 1
    this.save()

    if (!this.isWorkTime()) {
      this.snapshots.push({
        status: 'Idle',
      })
      this.save()
      return
    }

    let statusCode
    let responseTime
    let body
    const start = Date.now()
    fetch(this.URL, {
      method: this.method,
      headers: arrayToHeaders(this.headers),
      body: this.body,
    })
    .then((_res) => {
      statusCode = _res.status
      responseTime = Date.now() - start
      return _res[this.readType]()
    })
    .then((_body) => {
      body = _body
      new vm.Script(this.testCase).runInNewContext({
        assert,
        statusCode,
        responseTime,
        body,
        console: { log() {} },
      })

      this._errors = 0
      this.snapshots.push({
        status: 'OK',
        statusCode,
        responseTime,
      })
      this.save()
    })
    .catch((err) => {
      this.snapshots.push({
        status: 'Error',
        statusCode,
        responseTime,
        errMessage: err.message,
        body,
      })
      this.save()
      this.alert(err)
    })
  },

  isWorkTime() {
    if (!(this.workTime && this.workTime.length)) {
      return true
    }

    function compare(a, b) {
      for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) {
          return Math.sign(a[i] - b[i])
        }
      }
      return 0
    }

    const time = new Date()
    const timeArray = [
      time.getDay(),
      time.getHours(),
      time.getMinutes(),
    ]

    return this.workTime.some((range) => {
      if (compare(range[0], range[1]) <= 0) {
        return compare(range[0], timeArray) <= 0 &&
               compare(timeArray, range[1]) < 0
      }
      return compare(range[1], timeArray) <= 0 ||
             compare(timeArray, range[0]) < 0
    })
  },

  alert(err) {
    const settings = getSettings()
    if (this._errors === this.tolerance &&
        this.recipients.length &&
        settings.alertURL) {
      fetch(settings.alertURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipients: this.recipients,
          name: this.name,
          errMessage: err.message,
          detail: '',
        }),
      })
      .then(res => res.text())
      .then(console.log.bind(console))
      .catch(console.log.bind(console))
    }

    this._errors += 1
    this.save()
  },
}

ScoutSchema.statics = {
  patrolAll() {
    setInterval(() => {
      this.find().then((scouts) => {
        scouts.forEach((scout) => {
          scout.patrol()
        })
      })
    }, 60000)
  },
}

module.exports = mongoose.model('Scout', ScoutSchema)
