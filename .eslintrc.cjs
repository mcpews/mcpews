module.exports = {
    root: true,
    plugins: [
        '@typescript-eslint',
        'prettier'
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'prettier'
    ],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
    },
    env: {
        node: true,
        es6: true
    },
    rules: {
        'prettier/prettier': 'error',
        '@typescript-eslint/adjacent-overload-signatures': 'off',
        '@typescript-eslint/no-unsafe-declaration-merging': 'off'
    }
};