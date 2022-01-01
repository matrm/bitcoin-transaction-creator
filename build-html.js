const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const crypto = require("crypto");

function sha256(data) {
	// Hash binary data to get the same hash as other languages/services. See: https://stackoverflow.com/a/37227430
	return crypto.createHash('sha256').update(data, 'binary').digest('hex');
}

function verifyHash(hash, expectedHash, errorMessagePrefix) {
	//return;// Uncomment this return statement while testing to disable hash verification.
	if (hash !== expectedHash) {
		throw new Error(`${errorMessagePrefix || 'Unexpected hash.'}
Hash:          ${hash}
Expected hash: ${expectedHash}`);
	}
}

const bsvLibVersion = '1.5.6';
// This hash will need to be updated after changing bsvLibVersion.
const bsvLibExpectedHash = '3cf8ca3dec33161c8515f50e6135472b152aed677ec4ac176b4c82dae95db4d3';
// This hash will need to be updated when making changes to any parts of the HTML.
const htmlExpectedHash = '25d03426a5686197eabd7f1772cec4ccbca507cbf08d9d466021504a3000256c';

const libSaveFolder = 'lib';
// Create lib save folder if it doesn't exist yet.
if (!fs.existsSync(libSaveFolder)) {
	fs.mkdirSync(libSaveFolder);
	console.log(`Created ${libSaveFolder} folder.`);
}
const libBsvSaveFolder = path.join(libSaveFolder, 'bsv');
// Create bsv lib save folder if it doesn't exist yet.
if (!fs.existsSync(libBsvSaveFolder)) {
	fs.mkdirSync(libBsvSaveFolder);
	console.log(`Created ${libBsvSaveFolder} folder.`);
}
const libBsvVersionSaveFolder = path.join(libBsvSaveFolder, bsvLibVersion);
// Create bsv lib version save folder if it doesn't exist yet.
if (!fs.existsSync(libBsvVersionSaveFolder)) {
	fs.mkdirSync(libBsvVersionSaveFolder);
	console.log(`Created ${libBsvVersionSaveFolder} folder.`);
}
const bsvLibFilePath = path.join(libBsvVersionSaveFolder, 'bsv.min.js');
const invalidBsvLibFilePath = path.join(libBsvVersionSaveFolder, 'bsv.min.invalid.js');// For saving invalid downloads.

const encoding = 'utf8';

async function start() {
	let html = fs.readFileSync('src/index-template.html', encoding);
	assert(html.substr(0, 2) === '<!');

	const licenseText = fs.readFileSync('LICENSE', encoding);
	assert(licenseText.includes('icense'));

	if (!fs.existsSync(bsvLibFilePath)) {
		// File doesn't exist. Download first.
		const fetch = require('node-fetch');
		const url = `https://unpkg.com/bsv@${bsvLibVersion}/bsv.min.js`;
		console.log(`BSV library not downloaded yet. Downloading from "${url}".`);
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Unable to fetch "${url}": Response status "${response.statusText}".`);
		}
		// https://developer.mozilla.org/en-US/docs/Web/API/Response/redirected#Detecting_redirects
		if (response.redirected) {
			throw new Error(`Unable to fetch "${url}": Response redirected.`);
		}
		const buffer = await response.buffer();
		try {
			verifyHash(sha256(buffer), bsvLibExpectedHash, 'Downloaded BSV library unexpected hash.');
		} catch (error) {
			fs.writeFileSync(invalidBsvLibFilePath, buffer);
			console.log(`Saved to "${invalidBsvLibFilePath}".`);
			throw error;
		}
		fs.writeFileSync(bsvLibFilePath, buffer);
		console.log(`Saved to "${bsvLibFilePath}".`);
	}
	const bsvLib = fs.readFileSync(bsvLibFilePath, encoding);
	assert(bsvLib.substr(4, 3) === 'bsv');
	assert(bsvLib[7] === '=');

	assert(html.includes('<script>'));
	assert(html.includes('</script>'));
	const mainJs = fs.readFileSync('src/main.js', encoding);

	assert(html.includes('<style>'));
	assert(html.includes('</style>'));
	const mainCss = fs.readFileSync('src/main.css', encoding);

	html = html.replace('/* Replace with license */', licenseText);

	html = html.replace('/* Replace with javascript */',
`
${bsvLib}

${mainJs}
`);

html = html.replace('/* Replace with main.css */',
`
${mainCss}
`);

	// Verify bsv dependency.
	verifyHash(sha256(bsvLib), bsvLibExpectedHash, 'BSV library unexpected hash.');
	// Verify HTML.
	verifyHash(sha256(html), htmlExpectedHash, 'HTML unexpected hash.');

	const outputFileName = 'index.html';

	fs.writeFileSync(outputFileName, html);

	{
		// Verify file after saving.
		const encodedIndexHTML = fs.readFileSync(outputFileName);
		const decodedIndexHTML = fs.readFileSync(outputFileName, encoding);
		const encodedIndexHTMLhash = sha256(encodedIndexHTML);
		const decodedIndexHTMLhash = sha256(decodedIndexHTML);
		assert(encodedIndexHTMLhash == decodedIndexHTMLhash);
		verifyHash(encodedIndexHTMLhash, htmlExpectedHash, `${outputFileName} unexpected hash after saving. Try to build again.`);
	}

	console.log('Finished building, verifying, and saving index.html.');
}

start().catch(console.log);