import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	{
		files: ['tests/**'],
		rules: {
			'@n8n/community-nodes/no-restricted-imports': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
];
