
module.exports = EdgeGrid;
module.exports.Credentials = Credentials;
module.exports.Request = Request;
module.exports.Response = Response;

var uuid  = require('uuid');
var FS  = require('fs');
var URL = require('url');
var HTTPS = require('https');
var Crypto = require('crypto');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Stream = require('stream').Stream;

const RC = process.env.HOME + "/.edgerc";

util.inherits( Request, Stream.Writable );
// util.inherits( Response, Stream.Readable );
util.inherits( Response, EventEmitter );

var section_re = new RegExp( /^\s*\[\s*([^\]\s]*)\s*\]\s*$/ );
function section_header( line ) {
    var result = line.match(section_re);
    if ( result === null ) return null;
    return result[1];
}

var binding_re = new RegExp( /([^=]*)=(.*)/ );
function value_binding( line ) {
    var result = line.match(binding_re);
    if ( result === null ) return [null,null];
    return [ result[1].trim(), result[2].trim() ];
}

/*
 * Credentials object
 */
function Credentials( section ) {
    var section = section || 'default';
    this.load( section );
}

Credentials.prototype.keys = {};
Credentials.prototype.keys.client_secret = function ( secret ) {
    this.client_secret = secret;
};

Credentials.prototype.keys.host = function ( hostname ) {
    this.host = hostname;
};

Credentials.prototype.keys.access_token = function ( token ) {
    this.access_token = token;
};

Credentials.prototype.keys.client_token = function ( token ) {
    this.client_token = token;
};

Credentials.prototype.load = function ( section ) {
    // console.log( "Loading credentials from section '" + section + "'" );
    var current_section = null;
    function parse( line ) {
        var name = section_header( line );
        if ( name != null ) {
            current_section = name;
            return;
        }
        if ( current_section !== section ) return;
        var [ key, value ] = value_binding( line );
        if ( key === null ) return;
        var method = this.keys[ key ];
        if ( typeof method === 'undefined' ) return;
        method.call( this, value );
    }
    var lines = FS.readFileSync(RC).toString().split('\n');
    lines.forEach( parse.bind(this) );
};

// Make these new Error types
function throw_if_bad_credentials( credentials ) {
    if ( typeof credentials.host === 'undefined' ) throw new Error("Missing host in credentials");
}

function zero_fill( n ) {
    var s = (n < 10) ? "0" : "";
    return s + n;
}

function timestamp() {
    var now = new Date();
    var yr  = now.getUTCFullYear();
    var mo  = now.getUTCMonth() + 1;
    var dy  = now.getUTCDate();
    var h   = now.getUTCHours();
    var m   = now.getUTCMinutes();
    var s   = now.getUTCSeconds();

    var ts = yr.toString() + zero_fill(mo) + zero_fill(dy) + "T"
           + zero_fill(h) + ":" + zero_fill(m) + ":" + zero_fill(s)
           + "+0000";
    return ts;
}

// lower case header name + : + header value with spaces collapsed
function format_header( key ) {
    var proxy = this;
    key.toLowerCase() + ':' + headers[key].trim().replace(/\s+/g, ' ');
}

function hash_content( request ) {
    var method = request.proxy.method.toUpperCase();
    if ( method !== "POST" ) return '';
    // Also check if content size is > 0
    return body_hash( request.proxy.body );
}

function content( request ) {
    var content_hash = hash_content( request );

    var proxy = request.proxy;
    var filter = format_header.bind(proxy);
    var headers = request.headersToSign.map( filter ).join("\t");

    var fields = [
        proxy.method.toUpperCase(),
        'https', // proxy.protocol, // url.protocol.replace(':',''),
        request.credentials.host, // url.host,
        proxy.path, // url.path,
        headers, // headers
        content_hash,
        request.auth
    ];

    var data = fields.join('\t');
    return data;
}

function signing_key( timestamp, secret ) {
    var hash = Crypto.createHmac( 'sha256', secret );
    hash.update( timestamp );
    return hash.digest('base64');
}

function create_signature( request ) {
    var secret  = request.credentials.client_secret;
    var key     = signing_key( request.timestamp, secret );
    var hash    = Crypto.createHmac( 'sha256', key );

    var data = content( request );
    hash.update( data );
    return hash.digest('base64');
}

function auth_header( request ) {
    var client_token = request.credentials.client_token;
    var access_token = request.credentials.access_token;

    var header = 'EG1-HMAC-SHA256 client_token=' + client_token
                              + ';access_token=' + access_token
                              + ';timestamp='    + request.timestamp
                              + ';nonce='        + request.nonce + ';';

    return header;
}

const MAX_BODY = 8192;

function body_hash( body ) {
    function format(key) { return key + "=" + body[key]; };
    if ( typeof body === 'undefined' )  body = "";
    if ( typeof body === 'object' ) {
        body = Object.keys(body).map(format).join("&");
    }
    body = body.substring( 0, MAX_BODY );
    var hash = Crypto.createHash('sha256');
    hash.update( body );
    return hash.digest('base64');
}

/*
 * generate signature for body
 * generate unsigned auth header
 * generate random key to sign header
 * generate string to sign for header
 * add auth header
 */
function sign( request ) {
    request.timestamp = timestamp();
    request.nonce     = uuid.v4();
    request.auth      = auth_header( request );

    var signature = create_signature( request );

    // add header
    var auth = request.auth + "signature=" + signature;
    request.proxy.setHeader( 'Authorization', auth );
}

function Response( request ) {
    Stream.Readable.call( this );
    this.body = '';
    this.object = {};
}

function default_end_handler( data ) {
    console.log( "default EdgeGrid end" );
    this.emit( 'dto', JSON.parse(this.body) );
}

function default_data_handler( data ) {
    console.log( "data is " + (typeof data) );
    console.log( "default EdgeGrid data >" + data );
}

// Do what with it
function default_response_handler( response ) {
    response.on( 'data', default_data_handler );
    response.on( 'end', default_end_handler );
}

/*
 * Collect the HTTPS response chunks in the EdgeGrid.Response
 * object.
 */
function collect( chunk ) {
    this.body += chunk;
}

function end_handler() {
    this.emit( 'dto', JSON.parse(this.body) );
}

function readable_error( e ) {
    this.emit( 'error', e );
}

function accept( response ) {
    this.response = new Response();
    this.response.on( 'error', readable_error.bind(response) );

    // listen for events on the HTTPS response
    response.on( 'data', collect.bind(this.response) );
    response.on( 'end', end_handler.bind(this.response) );

    // invoke the callback for the EdgeGrid response
    this.callback( this.response );
}

/*
 * EdgeGrid.Request object
 *
 * Passed in callback is for EdgeGrid response.  There is an
 * internal callback for the HTTPS response.
 */
function Request( _params, callback ) {
    if ( typeof _params !== 'object' ) throw new Error("Bad argument");

    this.load_credentials( _params );
    this.headersToSign = [];
    this.callback = callback || default_response_handler;

    var params = {
        method: _params.method || 'GET',
        // path:   _params.path || '/contract-api/v1/contracts/identifiers?depth=ALL',
        path:   _params.path || '/papi/v1/groups',
        host:   this.credentials.host,
    };

    this.proxy = HTTPS.request( params, accept.bind(this) );
    sign( this );
    this.proxy.on( 'error', error_handler.bind(this.proxy) );
}

Request.prototype.load_credentials = function ( options ) {
    var credentials = options.credentials || new Credentials('default');
    throw_if_bad_credentials( credentials );
    this.credentials = credentials;
};

Request.prototype.end = function (data) {
    this.proxy.end(data);
};

function error_handler( error ) {
    // what are args to error handler??
    var request = this;
    console.log( "error " + error );
    console.log( "for request " + request );
}

// What would this do? - not create request...
function EdgeGrid( section ) {
    var section = section || 'default';
}

module.exports.request = function ( options, callback ) {
    return new Request( options, callback );
};

function respond( dto ) {
    var callback = this;
    callback( dto );
}

/*
 * trampoline() is used as a callback for an EdgeGrid request.
 */
function trampoline( response ) {
    response.on( 'dto', respond.bind(this) );
}

module.exports.get = function ( path, callback ) {
    var options = { path: path };
    var request = new Request( options, trampoline.bind(callback) );
    request.end();
    return request;
};

module.exports.post = function ( path, callback ) {
    var options = { method: "POST", path: path };
    var request = new Request( options, trampoline.bind(callback) );
    return request;
};

module.exports.put = function ( path, callback ) {
    var options = { method: "PUT", path: path };
    var request = new Request( options, trampoline.bind(callback) );
    request.end();
    return request;
};

module.exports.delete = function ( path, callback ) {
    var options = { method: "DELETE", path: path };
    var request = new Request( options, trampoline.bind(callback) );
    request.end();
    return request;
};

/* vim: set autoindent expandtab sw=4 syntax=javascript: */
