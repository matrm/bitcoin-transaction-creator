function assert(b) {
	if (!b) {
		const errorMessage = `Assertion failed: ${b}`;
		console.error(errorMessage);
		alert('Error: Assertion failure. Do not continue.');
		throw new Error(errorMessage);
	}
}

function splitStringFromNewLineAndComma(text) {
	return text
		// Convert commas to new lines.
		.split(',')
		.join('\n')

		.split('\n')
		// Remove lines that are empty or only have spaces.
		.map(line => line.trim())
		.filter(line => line.length);
}

function stringifyWithTabs(value) {
	return JSON.stringify(value, null, '\t');
}

async function checkIfConnectedToInternet() {
	const urls = [
		'https://api.bitindex.network/api/',
		'https://api.whatsonchain.com/v1/bsv/main/woc'
	];
	let numErrors = 0;
	await Promise.all(urls.map(url => fetch(url).catch(() => numErrors++)));
	return numErrors < urls.length;
}

function stringToTransaction(str) {
	str = str.trim();
	return (str.startsWith('{') && str.endsWith('}')) ? new bsv.Transaction(JSON.parse(str)) : new bsv.Transaction(str);
}

function getTransactionInfoObject(tx) {
	assert(tx instanceof bsv.Transaction);

	const inputAddressAmounts = {};// Sum of input amounts with each address.
	const nonStandardInputScriptCount = 0;
	for (const input of tx.inputs) {
		// Signed transactions have different properties than unsigned.
		const script = input.output ? input.output.script : input.script;
		assert(script instanceof bsv.Script);
		const address = script.toAddress().toString();
		const amount = input.output ? input.output.satoshis : null;// Change to undefined instead of null if this address shouldn't be a property when amount is unknown.
		if (!inputAddressAmounts[address]) {
			inputAddressAmounts[address] = amount;
		} else {
			inputAddressAmounts[address] += amount;
		}
		if (!script.isStandard()) {
			nonStandardInputScriptCount++;
		}
	}

	const outputAddressAmounts = {};// Sum of output amounts with each address.
	const nonStandardOutputScriptCount = 0;
	for (const output of tx.outputs) {
		assert(output.script instanceof bsv.Script);
		//assert(output.script.isPublicKeyHashOut());// This assertion can be used if no transactions created elsewhere are used.
		const address = output.script.toAddress().toString();
		const amount = output.satoshis;
		if (!outputAddressAmounts[address]) {
			outputAddressAmounts[address] = amount;
		} else {
			outputAddressAmounts[address] += amount;
		}
		if (!output.script.isStandard()) {
			nonStandardOutputScriptCount++;
		}
	}

	const warnings = [];
	{
		const lockTime = tx.getLockTime();
		if (lockTime) {
			warnings.push(`Locked until ${lockTime instanceof Date ? lockTime.toISOString() : 'block #' + lockTime}`);
		}
	}
	if (nonStandardInputScriptCount) {
		warnings.push(`${nonStandardInputScriptCount} non standard inputs`);
	}
	if (nonStandardOutputScriptCount) {
		warnings.push(`${nonStandardOutputScriptCount} non standard outputs`);
	}
	if (Object.keys(outputAddressAmounts).length != tx.outputs.length) {
		warnings.push('Multiple outputs with the same address');
	}
	const outputAddressInInputAddresses = Object.keys(outputAddressAmounts).reduce((matchFound, outputAddress) => matchFound || outputAddress in inputAddressAmounts, false);
	if (outputAddressInInputAddresses) {
		warnings.push('Addresses are being reused');
	}

	return {
		inputAddressAmounts,
		outputAddressAmounts,
		warnings
	};
}

function getTransactionInfoString(tx) {
	assert(tx instanceof bsv.Transaction);

	const transactionInfoObject = getTransactionInfoObject(tx);
	const indent = '   ';
	let str = '';

	assert(Array.isArray(transactionInfoObject.warnings));
	if (transactionInfoObject.warnings.length) {
		for (const warning of transactionInfoObject.warnings) {
			str += `Warning: ${warning}.\n`;
		}
		str += '\n';
	}

	str += 'Input address amounts:';
	assert(transactionInfoObject.inputAddressAmounts);
	for (const [address, amount] of Object.entries(transactionInfoObject.inputAddressAmounts)) {
		str += `\n${indent}${address}: ${amount || 'Unknown amount'}.`;
	}

	str += '\n\nOutput address amounts:';
	assert(transactionInfoObject.outputAddressAmounts);
	for (const [address, amount] of Object.entries(transactionInfoObject.outputAddressAmounts)) {
		str += `\n${indent}${address}: ${amount}.`;;
	}

	return str;
}

async function fetchAddressesUTXOs(addresses) {
	assert(Array.isArray(addresses));
	assert(addresses.length);
	assert(typeof addresses[0] == 'string');
	assert(addresses.length == [...new Set(addresses)].length);// Check for duplicate addresses.
	const url = `https://txdb.mattercloud.io/api/v1/txout/address/utxo/${addresses.join(',')}?offset=0&limit=1000&order=desc`;
	const response = await fetch(url);
	if (!response.ok) {
		console.log(response);
		throw new Error(`Request for addresses UTXOs rejected with status ${response.status}`);
	}
	const responseJSON = await response.json();
	const bloatedUTXOs = responseJSON.result;
	if (!Array.isArray(bloatedUTXOs)) {
		throw new Error(`Request for UTXOs expected an array but got a ${typeof bloatedUTXOs}`);
	}
	console.log(`Found ${bloatedUTXOs.length} UTXOs from ${addresses.length} addresses.`);

	// Returning bloatedUTXOs should work here but the UI will display useless properties downloaded from the API.

	const minimalUTXOs = bloatedUTXOs
		.map(utxo => new bsv.Transaction.UnspentOutput(utxo))
		.map(utxo => JSON.parse(JSON.stringify(utxo)))

		// Replace 'amount' property with 'satoshis' from bloatedUTXOs.
		// This must not come after sorting because it depends on having same indexes as bloatedUTXOs.
		.map((utxo, index) => {
			const satoshis = bloatedUTXOs[index].satoshis;
			if (satoshis) {
				delete utxo.amount;
				utxo.satoshis = satoshis;
			}
			return utxo;
		})

		// Sort by alphabetical order of the utxo in JSON format.
		.map(utxo => JSON.stringify(utxo))
		.sort()

		// While elements are strings may as well remove duplicates.
		// Not removing duplicates should only affect the UI. The output transaction should be the same either way.
		// Removing duplicates here allows checking if the API is broken assuming no duplicate addresses are allowed in this function.
		.filter((element, index, array) => array.indexOf(element) == index)

		.map(utxoString => JSON.parse(utxoString));

	// If this assertion fails then the API is broken.
	// Duplicate UTXOs should not be removed because no duplicate addresses should be passed to this function.
	assert(minimalUTXOs.length == bloatedUTXOs.length);

	return minimalUTXOs;
}

function createUnsignedTransaction(settings) {
	const utxos = settings.utxos;
	assert(Array.isArray(utxos));
	assert(utxos.length);
	const outputAddressesAndAmounts = settings.outputAddressesAndAmounts;
	assert(Array.isArray(outputAddressesAndAmounts));
	assert(outputAddressesAndAmounts.length);
	assert(outputAddressesAndAmounts[outputAddressesAndAmounts.length - 1].satoshis === undefined);

	const totalAmount = utxos.reduce((t, utxo) => t + utxo.satoshis, 0);
	console.log(`Total amount from UTXOs: ${totalAmount}.`);
	assert(totalAmount);

	// Amount to go to each output except change address.
	// Change address must be removed before iterating over outputAddressesAndAmounts to add
	// outputs to the tx and must come after the splitAmount calculation.
	const splitAmount = Math.floor(totalAmount / outputAddressesAndAmounts.length);
	assert(splitAmount);
	assert(splitAmount <= Number.MAX_SAFE_INTEGER);

	const changeAddress = outputAddressesAndAmounts.pop().address;

	let tx = new bsv.Transaction().from(utxos);

	// Make sure changeAddress was removed.
	assert(splitAmount == Math.floor(totalAmount / (outputAddressesAndAmounts.length + 1)));
	// Add all but change address (was the last element of oridinal outputAddressesAndAmounts).
	outputAddressesAndAmounts.forEach(addressAndAmount => {
		const address = addressAndAmount.address;
		assert(address);

		assert(addressAndAmount.satoshis === undefined || addressAndAmount.satoshis > 0);
		const amount = addressAndAmount.satoshis !== undefined ? addressAndAmount.satoshis : splitAmount;

		tx.to(address, amount);
	});

	tx.change(changeAddress);

	assert(tx instanceof bsv.Transaction);
	return tx;
}

function addressesTextAreaValueToArrayOfAddressStringsNoDuplicates(addressesText) {
	return splitStringFromNewLineAndComma(addressesText)
		// Check for invalid addresses.
		.map(address => new bsv.Address.fromString(address))
		.map(address => address.toString())

		// Remove duplicates.
		.filter((element, index, array) => array.indexOf(element) == index);
}

/* Return type example:
[
	{
		address: "1BitcoinEaterAddressDontSendf59kuE"
		satoshis: 10000
	},
	{
		address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	}
]
*/function outputAddressesTextAreaValueToAddressAmountObjects(text) {
	const addressBalanceDelimiter = ':';
	const addressAmountStrings = text
		// Convert commas to new lines.
		.split(',')
		.join('\n')

		.split('\n')
		.map(line => line.includes(addressBalanceDelimiter) ? line.trimLeft() : line.trim())
		.filter(line => line.length);

	const addressAmountObjects = addressAmountStrings.map(uiOutput => {
			// uiOutput can be "address:satoshis" or just "address".
			const [ address, satoshisString ] = uiOutput.split(addressBalanceDelimiter).map(value => value.trim());
			const satoshis = satoshisString ? parseInt(satoshisString) : undefined;

			// Check for errors.
			try {
				const addressTest = (new bsv.Address.fromString(address)).toString();
			} catch (error) {
				throw new Error(`Address "${address}" is not valid: ${error.message}`);
			}
			if (satoshisString !== undefined && (!Number.isSafeInteger(satoshis) || satoshis.toString() !== satoshisString) || satoshis < 1) {
				const satoshisStringUntrimmed = uiOutput.split(addressBalanceDelimiter)[1];
				const why = (() => {
					if (!Number.isSafeInteger(satoshis) && Number.isInteger(satoshis)) {
						return `Must be an integer below ${Number.MAX_SAFE_INTEGER + 1}`;
					} else if (satoshis < 1) {
						return 'Must be a bigger integer'
					}
					return 'Must be an integer';
				})();
				throw new Error(`Amount "${satoshisStringUntrimmed}" is invalid amount. ${why}.`);
			}

			return { address, satoshis };
		});

	// The last address must be a change address and not have a custom amount.
	if (addressAmountObjects.length && addressAmountObjects[addressAmountObjects.length - 1].satoshis !== undefined) {
		const lastString = addressAmountStrings[addressAmountStrings.length - 1];
		const fromDelimiterToEndOfLastString = lastString.substr(lastString.indexOf(addressBalanceDelimiter));
		throw new Error(
			`The change address (last output address entered) must not have a custom amount. Try removing "${fromDelimiterToEndOfLastString}" from "${lastString}".`
		);
	}

	return addressAmountObjects;
}

function privateKeysTextAreaValueToArrayOfPrivateKeys(privateKeysText) {
	return splitStringFromNewLineAndComma(privateKeysText)
		// Checks for invalid private keys.
		.map(privateKey => new bsv.PrivateKey.fromString(privateKey));
}

// For downloading UTXOs from addresses.
async function inputAddressesTextArea_to_inputUTXOsTextArea(inputAddressesTextArea, inputUTXOsTextArea) {
	assert(inputAddressesTextArea);
	assert(inputUTXOsTextArea);
	try {
		if (!inputAddressesTextArea.value) {
			throw new Error('Input addresses text area is empty.');
		}
		const inputAddresses = addressesTextAreaValueToArrayOfAddressStringsNoDuplicates(inputAddressesTextArea.value);
		if (!inputAddresses.length) {
			throw new Error('No valid input addresses.');
		}
		const utxos = await fetchAddressesUTXOs(inputAddresses);
		if (!utxos.length) {
			throw new Error('Found no UTXOs from input addresses.');
		}
		inputUTXOsTextArea.value = stringifyWithTabs(utxos);
		inputAddressesTextArea.value = '';
	} catch (error) {
		inputUTXOsTextArea.value = '';
		throw error;
	}
}

function addElementLineBreak(element) {
	assert(element);
	element.appendChild(document.createElement('br'));
	return element;
}

function addElementText(element, text) {
	assert(element);
	assert(text);
	element.appendChild(document.createTextNode(text));
	return element;
}

function removeElementChildren(element) {
	assert(element);
	// https://stackoverflow.com/a/3955238
	while (element.firstChild) {
		element.removeChild(element.firstChild);
	}
	return element;
}

function createElementWithInnerText(elementName, text) {
	assert(elementName);
	assert(text);
	const element = document.createElement(elementName);
	return addElementText(element, text);
}

function createButton(settings) {
	assert(settings.onclick instanceof Function || settings.onclick === undefined);
	assert(typeof settings.value == 'string' || settings.value === undefined);
	assert(typeof settings.title == 'string' || settings.title === undefined);
	const button = document.createElement('input');
	button.type = 'button';
	button.classList.add('input');
	button.classList.add('inputButton');
	button.classList.add('standardMargin');
	return Object.assign(button, settings);
}

function updateButtonVisibilityFromTextArea(button, textArea) {
	assert(button);
	assert(textArea);
	if (textArea.value) {
		button.disabled = false;
		button.style.opacity = 1.0;
		button.classList.add('inputButton');
	} else {
		button.disabled = true;
		button.style.opacity = 0.5;
		button.classList.remove('inputButton');
	}
}

function createCopyToClipboardFromTextAreaButton(textArea) {
	assert(textArea);
	const valueBeforeCopying = 'Copy';
	const valueAfterCopying = 'Copied';
	const button = createButton({ value: valueBeforeCopying });
	button.onclick = () => {
		textArea.select();
		document.execCommand("copy");
		button.value = valueAfterCopying;
		setTimeout(() => button.value = valueBeforeCopying, 3000);
	};
	updateButtonVisibilityFromTextArea(button, textArea);
	return button;
}

function createTextArea(settings) {
	return Object.assign(document.createElement('textarea'), settings);
}

function clearBody() {
	removeElementChildren(document.body);
}

function createContainer() {
	const container = document.createElement('div');
	container.classList.add('container');
	return container;
}

function renderUnsignedTransactionCreation() {
	clearBody();

	const DOWNLOAD_UTXOS_FROM_ADDRESSES_BUTTON_NAME = 'Download UTXOs From Addresses';
	const CREATE_UNSIGNED_TRANSACTION_BUTTON_NAME = 'Create Unsigned Transaction';

	const container = createContainer();

	container.appendChild(createElementWithInnerText('h1', 'Create Unsigned Transaction'));

	container.appendChild(createButton({
		value: 'Back',
		onclick: renderDefault
	}));
	container.appendChild(createButton({
		value: 'Reset',
		onclick: renderUnsignedTransactionCreation
	}));

	const inputAddressesTextArea = createTextArea({
		placeholder: `Addresses separated by commas or new lines. Used to search for UTXOs to be used for transaction inputs.

For example:

Address1,Address2,Address3,Address4

or

Address1
Address2
Address3
Address4`,
		rows: 18,
		cols: 60
	});

	const inputUTXOsTextArea = createTextArea({
		placeholder: `UTXOs to use for transaction inputs.
Press the "${DOWNLOAD_UTXOS_FROM_ADDRESSES_BUTTON_NAME}" or
the "${CREATE_UNSIGNED_TRANSACTION_BUTTON_NAME}" button to download
these automatically from address inputs.`,
		rows: 18,
		cols: 96
	});

	const outputAddressesTextArea = createTextArea({
		placeholder: `Addresses separated by commas or new lines.
Used as transaction outputs. Optionally add ":amount"
after an address (except the last one) to use a
custom amount. All addresses that don't have a
custom amount will split the remaining amount,
except the last address that will pay the fee.

For example:

Address1:30000
Address2:15000
Address3
Address4
Address5:25000
Address6

If the total amount is 85000: Address3 and Address4 will get 5000. Address6 will get 5000 - fee.`,
		rows: 18,
		cols: 60
	});

	const downloadUTXOsButton = createButton({
		value: DOWNLOAD_UTXOS_FROM_ADDRESSES_BUTTON_NAME,
		onclick: async () => {
			try {
				await inputAddressesTextArea_to_inputUTXOsTextArea(inputAddressesTextArea, inputUTXOsTextArea);
			} catch (error) {
				console.log(error);
				alert(`Unable to convert addresses to UTXOs: ${error.message}`);
			}
		}
	});

	const unsignedTransactionTextArea = createTextArea({
		placeholder: 'An unsigned transaction will be output here that can be signed using private keys.',
		rows: 18,
		cols: 60,
		readOnly: true
	});

	const copyUnsignedTransactionTextAreaButton = createCopyToClipboardFromTextAreaButton(unsignedTransactionTextArea);

	const createUnsignedTransactionButton = createButton({
		value: CREATE_UNSIGNED_TRANSACTION_BUTTON_NAME,
		onclick: async () => {
			try {
				if (inputAddressesTextArea.value) {
					if (inputUTXOsTextArea.value) {
						if (confirm('Clear current UTXOs and download new ones from input addresses?')) {
							inputUTXOsTextArea.value = '';
						} else {
							inputAddressesTextArea.value = '';
						}
					}
					assert(inputAddressesTextArea.value || inputUTXOsTextArea.value);
					assert(!inputAddressesTextArea.value || !inputUTXOsTextArea.value);
					if (inputAddressesTextArea.value) {
						assert(!inputUTXOsTextArea.value);
						await inputAddressesTextArea_to_inputUTXOsTextArea(inputAddressesTextArea, inputUTXOsTextArea);
					}
				} else if (!inputUTXOsTextArea.value) {
					throw new Error('Input text areas are empty.');
				}
				const utxos = JSON.parse(inputUTXOsTextArea.value).map(utxo => new bsv.Transaction.UnspentOutput(utxo));
				if (!utxos.length) {
					console.log('UTXOs:');
					console.log(utxos);
					throw new Error('No UTXOs.');
				}
				const outputAddressesAndAmounts = outputAddressesTextAreaValueToAddressAmountObjects(outputAddressesTextArea.value);
				if (!outputAddressesAndAmounts.length) {
					console.log('Output addresses and amounts:');
					console.log(outputAddressesAndAmounts);
					throw new Error('No valid output addresses.');
				}
				const unsignedTransaction = createUnsignedTransaction({ utxos, outputAddressesAndAmounts });
				/* From https://github.com/moneybutton/bsv/blob/master/docs/transaction.md#serialization
					"toObject: Returns a plain JavaScript object with no methods and enough information to
					fully restore the state of this transaction. Using other serialization methods (except
					for toJSON) will cause a some information to be lost."
					unsignedTransaction.toJSON() is not used because it returns JSON with spaces.
				*/
				const unsignedTransactionString = JSON.stringify(unsignedTransaction.toObject());
				unsignedTransactionTextArea.value = unsignedTransactionString;
				updateButtonVisibilityFromTextArea(copyUnsignedTransactionTextAreaButton, unsignedTransactionTextArea);
			} catch (error) {
				console.log(error);
				alert(`Unable to create transaction: ${error.message}`);
			}
		}
	});

	const table = document.createElement('table');
	table.classList.add('standardMargin');

	// First row. User inputs.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		// From.
		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(createElementWithInnerText('h2', 'From:'));
			td.appendChild(createElementWithInnerText('p', 'Fill in one of these text areas.'));
			td.appendChild(inputAddressesTextArea);
			addElementLineBreak(td);
			td.appendChild(downloadUTXOsButton);
			addElementLineBreak(td);
			td.appendChild(inputUTXOsTextArea);

			return td;
		})());

		// To.
		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(createElementWithInnerText('h2', 'To:'));
			td.appendChild(outputAddressesTextArea);

			return td;
		})());


		return tr;
	})());

	// Second row. Unsigned transaction output.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		tr.appendChild((() => {
			const td = document.createElement('td');
			td.colSpan = 2;// https://stackoverflow.com/a/48871500

			td.appendChild(createUnsignedTransactionButton);
			addElementLineBreak(td);
			td.appendChild(unsignedTransactionTextArea);
			addElementLineBreak(td);
			td.appendChild(copyUnsignedTransactionTextAreaButton);

			return td;
		})());

		return tr;
	})());

	container.appendChild(table);

	document.body.appendChild(container);
}

function renderTransactionSigner() {
	clearBody();

	const container = createContainer();

	container.appendChild(createElementWithInnerText('h1', 'Sign Unsigned Transaction'));

	container.appendChild(createButton({
		value: 'Back',
		onclick: renderDefault
	}));
	container.appendChild(createButton({
		value: 'Reset',
		onclick: renderTransactionSigner
	}));

	const unsignedTransactionTextArea = createTextArea({
		placeholder: 'Unsigned transaction that will be signed using private keys.',
		rows: 18,
		cols: 60
	});

	const privateKeysTextArea = createTextArea({
		placeholder: `Private keys separated by commas or new lines.
Used to sign the unsigned transaction.

For example:

PrivateKey1,PrivateKey2,PrivateKey3,PrivateKey4

or

PrivateKey1
PrivateKey2
PrivateKey3
PrivateKey4`,
		rows: 18,
		cols: 60
	});

	const signedTransactionTextArea = createTextArea({
		placeholder: 'A signed transaction will be output here that can be broadcast to the bitcoin network.',
		rows: 18,
		cols: 60,
		readOnly: true
	});

	const copySignedTransactionTextAreaButton = createCopyToClipboardFromTextAreaButton(signedTransactionTextArea);

	const signTransactionButton = createButton({
		value: 'Sign Unsigned Transaction',
		onclick: () => {
			try {
				if (!unsignedTransactionTextArea.value) {
					throw new Error('Unsigned transaction text area is empty.');
				}
				if (!privateKeysTextArea.value) {
					throw new Error('Private keys text area is empty.');
				}
				const tx = stringToTransaction(unsignedTransactionTextArea.value);
				const privateKeys = privateKeysTextAreaValueToArrayOfPrivateKeys(privateKeysTextArea.value);
				tx.sign(privateKeys);
				const txSerialized = tx.serialize();
				console.log('Signed transaction:', txSerialized);
				signedTransactionTextArea.value = txSerialized;
				privateKeysTextArea.value = '';
				updateButtonVisibilityFromTextArea(copySignedTransactionTextAreaButton, signedTransactionTextArea);
			} catch (error) {
				console.log(error);
				alert(`Unable to sign transaction: ${error.message}`);
			}
		}
	});

	const table = document.createElement('table');
	table.classList.add('standardMargin');

	// First row. User inputs.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		// Unsigned transaction user input.
		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(createElementWithInnerText('h2', 'Unsigned Transaction:'));
			td.appendChild(unsignedTransactionTextArea);

			return td;
		})());

		// Private keys user input.
		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(createElementWithInnerText('h2', 'Private Keys:'));
			td.appendChild(privateKeysTextArea);

			return td;
		})());

		return tr;
	})());

	// Second row. Signed transaction output.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		tr.appendChild((() => {
			const td = document.createElement('td');
			td.colSpan = 2;// https://stackoverflow.com/a/48871500

			td.appendChild(signTransactionButton);
			addElementLineBreak(td);
			td.appendChild(signedTransactionTextArea);
			addElementLineBreak(td);
			td.appendChild(copySignedTransactionTextAreaButton);

			return td;
		})());

		return tr;
	})());

	container.appendChild(table);

	document.body.appendChild(container);

	checkIfConnectedToInternet().then(connectedToInternet => {
		if (connectedToInternet) {
			alert('Warning: Signing a transaction while connected to the internet is not recommended.');
		}
	});
}

function renderTransactionViewer() {
	clearBody();

	const container = createContainer();

	container.appendChild(createElementWithInnerText('h1', 'View Transaction'));

	container.appendChild(createButton({
		value: 'Back',
		onclick: renderDefault
	}));
	container.appendChild(createButton({
		value: 'Reset',
		onclick: renderTransactionViewer
	}));

	const transactionTextArea = createTextArea({
		placeholder: 'Signed or unsigned transaction.',
		rows: 18,
		cols: 80
	});

	const viewTransactionTextArea = createTextArea({
		placeholder: 'Info about the transaction will be output here.',
		rows: 18,
		cols: 80,
		readOnly: true
	});

	const copyViewTransactionTextAreaButton = createCopyToClipboardFromTextAreaButton(viewTransactionTextArea);

	const simpleTransactionViewButton = createButton({
		value: 'Simple Transaction View',
		onclick: () => {
			try {
				if (!transactionTextArea.value) {
					throw new Error('Transaction text area is empty.');
				}
				const tx = stringToTransaction(transactionTextArea.value);
				viewTransactionTextArea.value = getTransactionInfoString(tx);
				updateButtonVisibilityFromTextArea(copyViewTransactionTextAreaButton, viewTransactionTextArea);
			} catch (error) {
				console.log(error);
				alert(`Unable to view transaction: ${error.message}`);
			}
		}
	});

	const advancedTransactionViewButton = createButton({
		value: 'Advanced Transaction View',
		onclick: () => {
			try {
				if (!transactionTextArea.value) {
					throw new Error('Transaction text area is empty.');
				}
				const tx = stringToTransaction(transactionTextArea.value);
				viewTransactionTextArea.value = stringifyWithTabs(tx.toObject());
				updateButtonVisibilityFromTextArea(copyViewTransactionTextAreaButton, viewTransactionTextArea);
			} catch (error) {
				console.log(error);
				alert(`Unable to view transaction: ${error.message}`);
			}
		}
	});

	const table = document.createElement('table');
	table.classList.add('standardMargin');

	// First row. User inputs.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		// Transaction user input.
		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(createElementWithInnerText('h2', 'Transaction:'));
			td.appendChild(transactionTextArea);

			return td;
		})());

		return tr;
	})());

	// Second row. View transaction output.
	table.appendChild((() => {
		const tr = document.createElement('tr');

		tr.appendChild((() => {
			const td = document.createElement('td');

			td.appendChild(simpleTransactionViewButton);
			td.appendChild(advancedTransactionViewButton);
			addElementLineBreak(td);
			td.appendChild(viewTransactionTextArea);
			addElementLineBreak(td);
			td.appendChild(copyViewTransactionTextAreaButton);

			return td;
		})());

		return tr;
	})());

	container.appendChild(table);

	document.body.appendChild(container);
}

function renderDefault() {
	clearBody();

	const container = createContainer();

	container.appendChild(createElementWithInnerText('h1', 'Bitcoin Transaction Creator'));

	container.appendChild(createButton({
		value: 'Create Unsigned Transaction',
		onclick: renderUnsignedTransactionCreation
	}));

	container.appendChild(createButton({
		value: 'Sign Unsigned Transaction',
		onclick: renderTransactionSigner
	}));

	container.appendChild(createButton({
		value: 'View Transaction',
		onclick: renderTransactionViewer
	}));

	document.body.appendChild(container);
}

window.onload = renderDefault;