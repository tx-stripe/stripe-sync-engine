import dotenv from 'dotenv'
import inquirer from 'inquirer'
import chalk from 'chalk'

export interface Config {
  stripeApiKey: string
  databaseUrl: string
}

export interface CliOptions {
  stripeKey?: string
  databaseUrl?: string
}

/**
 * Load configuration from .env file, environment variables, and interactive prompts.
 * Values are masked with *** when prompting for sensitive information.
 */
export async function loadConfig(options: CliOptions): Promise<Config> {
  // Load .env file
  dotenv.config()

  const config: Partial<Config> = {}

  // Get Stripe API key
  config.stripeApiKey =
    options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''

  // Get database URL
  config.databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

  // Prompt for missing required values
  const questions: inquirer.QuestionCollection = []

  if (!config.stripeApiKey) {
    questions.push({
      type: 'password',
      name: 'stripeApiKey',
      message: 'Enter your Stripe API key:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.trim() === '') {
          return 'Stripe API key is required'
        }
        if (!input.startsWith('sk_')) {
          return 'Stripe API key should start with "sk_"'
        }
        return true
      },
    })
  }

  if (!config.databaseUrl) {
    questions.push({
      type: 'password',
      name: 'databaseUrl',
      message: 'Enter your Postgres DATABASE_URL:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.trim() === '') {
          return 'DATABASE_URL is required'
        }
        if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
          return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
        }
        return true
      },
    })
  }

  if (questions.length > 0) {
    console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
    const answers = await inquirer.prompt(questions)
    Object.assign(config, answers)
  }

  return config as Config
}
