import LoginForm from '../LoginForm';

export default function LoginFormExample() {
  // todo: remove mock functionality
  const handleLogin = (credentials: { email: string; password: string; role: string }) => {
    console.log('Login attempted:', credentials);
  };

  return <LoginForm onLogin={handleLogin} />;
}