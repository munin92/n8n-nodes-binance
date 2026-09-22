import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'test/**', '*.js', '*.mjs'] },
	{
		files: ['nodes/**/*.ts', 'credentials/**/*.ts'],
		extends: [...tseslint.configs.recommended],
		languageOptions: { parserOptions: { project: './tsconfig.json' } },
	},
	{
		files: ['package.json'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { extraFileExtensions: ['.json'], project: null },
		},
	},
	n8nCommunityNodesPlugin.configs.recommended,
);
