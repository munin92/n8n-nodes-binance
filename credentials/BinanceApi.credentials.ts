import { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class BinanceApi implements ICredentialType {
	name = 'binanceApi';
	displayName = 'Binance API';
	icon: Icon = 'file:../nodes/Binance/binance.svg';
	documentationUrl = 'https://developers.binance.com/docs/binance-spot-api-docs';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Binance API key with "Enable Reading" only',
		},
		{
			displayName: 'Secret Key',
			name: 'apiSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];
}
