export class AuthFlowError extends Error {
  readonly code:
    | 'emailConfirmationRequired'
    | 'invalidCredentials'
    | 'notSignedIn'
    | 'message'

  constructor(
    code: AuthFlowError['code'],
    message: string
  ) {
    super(message)
    this.name = 'AuthFlowError'
    this.code = code
  }

  static emailConfirmationRequired(): AuthFlowError {
    return new AuthFlowError(
      'emailConfirmationRequired',
      'Check your email to confirm your account, then sign in.'
    )
  }

  static invalidCredentials(): AuthFlowError {
    return new AuthFlowError('invalidCredentials', 'Invalid email or password.')
  }

  static notSignedIn(): AuthFlowError {
    return new AuthFlowError('notSignedIn', 'You need to be signed in to continue.')
  }

  static message(text: string): AuthFlowError {
    return new AuthFlowError('message', text)
  }
}

export function friendlyAuthMessage(error: unknown): string {
  if (error instanceof AuthFlowError) return error.message

  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.'

  if (/invalid login|invalid credentials/i.test(text)) {
    return AuthFlowError.invalidCredentials().message
  }
  if (/already registered|user already/i.test(text)) {
    return 'An account with this email already exists. Try logging in.'
  }
  return text
}
